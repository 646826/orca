import { createHash, randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import type Database from '../../sqlite/sync-database'
import { ConversationScratchClient } from './conversation-scratch-client'
import { ConversationReplayResourceLimit } from './conversation-replay-resource-limit'
import { createConversationPresentationBatch } from './conversation-presentation-batch'
import { createConversationToolEvidenceProjection } from './conversation-context-row-validation'
import {
  pinJournalEpoch,
  releaseJournalEpochPins,
  type JournalEpochPin
} from '../agent-session-journal/journal-epoch-pins'
import { runJournalTransaction } from '../agent-session-journal/journal-transaction'
import { ConversationExportError } from './conversation-export-error'
import type { ConversationItemPageCursor } from './conversation-reducer-disk-map'
import { assertConversationSourceVersionPin } from './conversation-source-version'

/** Presentation only: no original-text API and no context-delivery authority. Original bytes
 * remain pinned canonical evidence; only allowlisted tool leaves are streamed into previews. */
export async function buildConversationPresentationPages(input: {
  db: Database.Database
  pin: JournalEpochPin
  scratchDirectory: string
  maxCanonicalBytes: number
  signal: AbortSignal
  scratch?: ConversationScratchClient
  assertCurrent?: () => void
}) {
  const { db, signal } = input
  ConversationScratchClient.assertAdmission(input.scratchDirectory)
  if (db.isTransaction) {
    throw new Error('Presentation replay requires no writer transaction')
  }
  if (!Number.isSafeInteger(input.maxCanonicalBytes) || input.maxCanonicalBytes < 1) {
    throw new RangeError('Invalid presentation byte limit')
  }
  await ConversationScratchClient.retryPending(input.scratchDirectory)
  ConversationScratchClient.assertAdmission(input.scratchDirectory)
  if (signal.aborted) {
    return { kind: 'refused' as const, reason: 'cancelled' as const }
  }
  input.assertCurrent?.()
  const pin = { ...input.pin, ownerId: `conversation-presentation:${randomUUID()}` }
  runJournalTransaction(db, () => pinJournalEpoch(db, pin))
  let scratch = input.scratch
  let published = false,
    closing = false,
    released = false
  let unregisterCleanup: (() => void) | undefined
  const release = () => {
    if (released) {
      return
    }
    runJournalTransaction(db, () => releaseJournalEpochPins(db, pin.ownerId))
    released = true
    unregisterCleanup?.()
  }
  let pageInFlight: Promise<unknown> | undefined
  const check = () => {
    signal.throwIfAborted()
    ConversationScratchClient.assertAdmission(input.scratchDirectory)
    input.assertCurrent?.()
    assertConversationSourceVersionPin(db, {
      pin,
      source: { sessionId: pin.sessionId, epoch: pin.epoch, sequence: pin.endSequence }
    })
  }
  const close = async () => {
    closing = true
    if (released) {
      return
    }
    await pageInFlight?.catch(() => {})
    if (scratch) {
      await (input.scratch ? scratch.closeReplay() : scratch.close())
    }
    release()
  }
  try {
    const size = db
      .prepare(
        'SELECT SUM(octet_length(row_json)) bytes FROM journal_rows WHERE session_id=? AND epoch=? AND seq BETWEEN 1 AND ?'
      )
      .get(pin.sessionId, pin.epoch, pin.endSequence)?.bytes
    if (typeof size !== 'number' || size > input.maxCanonicalBytes) {
      return { kind: 'refused' as const, reason: 'resource-limit' as const }
    }
    scratch ??= new ConversationScratchClient(input.scratchDirectory)
    unregisterCleanup = scratch.onCleanup(release)
    await scratch.ready
    check()
    await scratch.openReplay(pin)
    check()
    const batch = createConversationPresentationBatch({
      db,
      append: scratch.appendReplay.bind(scratch),
      assertCurrent: check
    })
    let yieldedAt = performance.now()
    for (let sequence = 1; sequence <= pin.endSequence; sequence++) {
      check()
      const source = { sessionId: pin.sessionId, epoch: pin.epoch, sequence }
      const length = db
        .prepare(
          'SELECT octet_length(row_json) bytes FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?'
        )
        .get(pin.sessionId, pin.epoch, sequence)?.bytes
      if (typeof length !== 'number') {
        throw new Error('Presentation source missing')
      }
      const parser = createConversationToolEvidenceProjection({
        referenceText: `[Tool output shortened for display; original retained at ${pin.epoch}:${sequence}.]`,
        byteLength: length
      })
      const hash = createHash('sha256'),
        decoder = new TextDecoder('utf-8', { fatal: true })
      for (let offset = 0; offset < length;) {
        check()
        const count = Math.min(64 * 1024, length - offset)
        const bytes = db
          .prepare(
            'SELECT substr(CAST(row_json AS BLOB),?,?) bytes FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?'
          )
          .get(offset + 1, count, pin.sessionId, pin.epoch, sequence)?.bytes
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== count) {
          throw new Error('Presentation source missing')
        }
        hash.update(bytes)
        parser.write(decoder.decode(bytes, { stream: true }))
        offset += count
        if (offset < length) {
          await setImmediate(undefined, { signal })
        }
      }
      parser.write(decoder.decode())
      const { projectedRow: row, substitutedPaths } = parser.end()
      if (row.epoch !== pin.epoch || row.seq !== sequence) {
        throw new Error('Presentation source mismatch')
      }
      const committed = await batch.add(
        {
          seq: sequence,
          ts: row.ts,
          rowJson: JSON.stringify(row),
          ...(row.kind === 'item'
            ? { shortenedItem: { itemId: row.itemId, shortened: substitutedPaths.length > 0 } }
            : {})
        },
        {
          pin,
          source,
          sha256: hash.digest('hex'),
          byteLength: length,
          kind: row.kind,
          mutationCount: row.kind === 'lifecycle-batch' ? row.mutations.length : 0
        }
      )
      if (committed || performance.now() - yieldedAt >= 8) {
        await setImmediate(undefined, { signal })
        yieldedAt = performance.now()
      }
    }
    if (await batch.flush()) {
      await setImmediate(undefined, { signal })
    }
    check()
    const loaded = await scratch.finishReplay()
    check()
    if (loaded.damage || loaded.newer) {
      return {
        kind: 'refused' as const,
        reason: loaded.newer ? ('newer-schema' as const) : ('invalid-provenance' as const)
      }
    }
    const pages = scratch
    published = true
    return {
      kind: 'built' as const,
      lease: {
        itemPage: async (
          after: ConversationItemPageCursor | null,
          limit: number,
          maxBytes?: number
        ) => {
          if (closing) {
            throw new Error('Presentation replay is closed')
          }
          check()
          const pending = pages.replayPage(after, limit, maxBytes)
          pageInFlight = pending
          try {
            const page = await pending
            if (closing) {
              throw new Error('Presentation replay is closed')
            }
            check()
            return page
          } finally {
            if (pageInFlight === pending) {
              pageInFlight = undefined
            }
          }
        },
        close
      }
    }
  } catch (error) {
    if (signal.aborted) {
      return { kind: 'refused' as const, reason: 'cancelled' as const }
    }
    if (error instanceof ConversationReplayResourceLimit) {
      return { kind: 'refused' as const, reason: 'resource-limit' as const }
    }
    if (error instanceof ConversationExportError) {
      return {
        kind: 'refused' as const,
        reason:
          error.code === 'newer-schema'
            ? ('newer-schema' as const)
            : error.code === 'resource-limit'
              ? ('resource-limit' as const)
              : ('invalid-provenance' as const)
      }
    }
    throw error
  } finally {
    if (!published) {
      await close()
    }
  }
}
