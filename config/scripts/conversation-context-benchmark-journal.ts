import { conversationContextDigest } from '../../src/main/native-chat/conversations/conversation-context-consent'
import { agentJournalItemForWire } from '../../src/main/native-chat/agent-session-wire/agent-session-item-wire-form'
import { boundedFrameItem } from '../../src/main/native-chat/agent-session-wire/agent-session-bounded-frame-item'
import { startBenchmarkLoopMeasurement } from './conversation-context-benchmark-loop.mjs'
import { benchmarkPhase } from './conversation-context-benchmark-process.mjs'
import { createHash } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { setImmediate as yieldLoop } from 'node:timers/promises'
import { conversationBenchmarkRows } from './conversation-context-benchmark-rows.mjs'
import { JournalHostDatabase } from '../../src/main/native-chat/agent-session-journal/journal-host-database'
import { insertJournalRow } from '../../src/main/native-chat/agent-session-journal/journal-row-table'
import {
  pinJournalEpoch,
  iteratePinnedJournalEpochRows
} from '../../src/main/native-chat/agent-session-journal/journal-epoch-pins'
import { startJournalRowFold } from '../../src/main/native-chat/agent-session-journal/journal-open'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../src/shared/agent-session-journal-types'
import { buildConversationPresentationPages } from '../../src/main/native-chat/conversations/conversation-presentation-pages'
import type { ConversationItemPageCursor } from '../../src/main/native-chat/conversations/conversation-reducer-disk-map'

/** Replay-only lane. Does not claim full manifest compilation, consent or delivery. */
export async function measureConversationJournal(request: {
  lane: 'journal' | 'baseline-journal'
  stateDirectory: string
  eventCount: number
}): Promise<unknown> {
  const setupStarted = performance.now()
  benchmarkPhase('setup-start')
  await mkdir(request.stateDirectory)
  const host = JournalHostDatabase.open(request.stateDirectory)
  let stopLoopMeasurement: ReturnType<typeof startBenchmarkLoopMeasurement> | undefined
  try {
    const expected = createHash('sha256')
    let bytes = 0
    host.transaction((db) => {
      for (const row of conversationBenchmarkRows(
        request.eventCount,
        AGENT_SESSION_JOURNAL_SCHEMA_VERSION
      )) {
        insertJournalRow(db, 'synthetic-session', row)
      }
    })
    const pin = {
      ownerId: 'benchmark-source',
      sessionId: 'synthetic-session',
      epoch: 'synthetic',
      endSequence: request.eventCount + 1
    }
    host.transaction((db) => pinJournalEpoch(db, pin))
    for (const row of iteratePinnedJournalEpochRows(host.db, pin)) {
      expected.update(row.rowJson).update('\n')
      bytes += Buffer.byteLength(row.rowJson)
    }
    const expectedHash = expected.digest('hex')
    const idleRssBytes = process.memoryUsage().rss
    const setupPeakRssBytes = process.resourceUsage().maxRSS * 1024
    const startedAt = new Date().toISOString()
    const setupElapsedMs = performance.now() - setupStarted
    benchmarkPhase('setup-end')
    stopLoopMeasurement = startBenchmarkLoopMeasurement()
    const started = performance.now()
    const actual = createHash('sha256')
    const itemDigests: string[] = []
    let sourceCount = 0
    let itemCount = 0
    if (request.lane === 'journal') {
      const result = await buildConversationPresentationPages({
        db: host.db,
        pin,
        scratchDirectory: request.stateDirectory,
        maxCanonicalBytes: bytes,
        signal: new AbortController().signal
      })
      if (result.kind !== 'built') {
        throw new Error(`Replay refused: ${result.reason}`)
      }
      try {
        for (const row of iteratePinnedJournalEpochRows(host.db, pin)) {
          actual.update(row.rowJson).update('\n')
          sourceCount++
          if (sourceCount % 128 === 0) {
            await yieldLoop()
          }
        }
        let after: ConversationItemPageCursor | null = null
        while (true) {
          const page = await result.lease.itemPage(after, 128)
          if (!page.items.length) {
            break
          }
          for (const item of page.items) {
            itemDigests.push(
              conversationContextDigest({
                itemId: item.itemId,
                revision: item.revision,
                body: item.body
              })
            )
          }
          itemCount += page.items.length
          after = page.next
          await yieldLoop()
        }
      } finally {
        await result.lease.close()
      }
    } else {
      const fold = startJournalRowFold(pin)
      for (const row of iteratePinnedJournalEpochRows(host.db, pin)) {
        actual.update(row.rowJson).update('\n')
        sourceCount++
        if (!fold.add(row)) {
          throw new Error('Baseline fold stopped')
        }
      }
      const result = fold.finish()
      if (result.damage || result.newer) {
        throw new Error('Baseline unreadable')
      }
      itemCount = result.state.items.size
      for (const canonical of result.state.items.values()) {
        const item = boundedFrameItem(agentJournalItemForWire(canonical)).item
        itemDigests.push(
          conversationContextDigest({
            itemId: item.itemId,
            revision: item.revision,
            body: item.body
          })
        )
      }
    }
    const integrity =
      actual.digest('hex') === expectedHash &&
      sourceCount === request.eventCount + 1 &&
      itemCount === (request.eventCount / 10) * 5
    const elapsedMs = performance.now() - started
    const loopMeasurement = stopLoopMeasurement()
    benchmarkPhase('operation-end')
    return {
      status: 'completed',
      integrity,
      elapsedMs,
      setupElapsedMs,
      idleRssBytes,
      setupPeakRssBytes,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      ...loopMeasurement,
      startedAt,
      finishedAt: new Date().toISOString(),
      byteLength: bytes,
      sourceCount,
      itemCount,
      expectedHash,
      presentationItemDigest: conversationContextDigest(itemDigests.sort()),
      distribution: {
        epoch: 1,
        submission: request.eventCount / 10,
        dispatch: request.eventCount / 5,
        providerUserEchoes: request.eventCount / 5,
        assistant: (request.eventCount * 3) / 10,
        tool: request.eventCount / 5,
        revisions: request.eventCount / 5
      },
      verification:
        'Canonical source-byte SHA/count audit and wire-normalized presentation item identity/revision/body digest and count; not full preparation/compiler or model quality'
    }
  } finally {
    stopLoopMeasurement?.()
    host.close()
    await rm(request.stateDirectory, { recursive: true, force: true })
    benchmarkPhase('cleanup-end')
  }
}
