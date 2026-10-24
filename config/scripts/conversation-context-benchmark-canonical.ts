import { createHash } from 'node:crypto'
import { createPreparationBenchmarkFixture } from './conversation-context-benchmark-preparation-fixture'
import { BENCHMARK_CONSTRAINT } from './conversation-context-benchmark-preparation-seed'
import {
  freezeConversationPreparationSources,
  readConversationPreparationSourceRows
} from '../../src/main/native-chat/conversations/conversation-preparation-sources'
import { createConversationPreparationRows } from '../../src/main/native-chat/conversations/conversation-preparation-rows'
import { exportConversationContext } from '../../src/main/native-chat/conversations/conversation-context-export'
import { streamConversationExportRows } from '../../src/main/native-chat/conversations/conversation-context-export-reader'

/** Actual frozen host sources and production export/projectors; no native delivery claim. */
export async function createCanonicalBenchmark(stateDirectory: string, toolRowBytes: number) {
  const fixture = await createPreparationBenchmarkFixture({
    stateDirectory,
    eventCount: 10,
    policy: 'budgeted',
    requiredTextBytes: 32,
    toolRowBytes
  })
  const { host, intent, attachments } = fixture
  const signal = new AbortController().signal
  const snapshot = await freezeConversationPreparationSources(host.db, intent, signal).catch(
    (error) => {
      fixture.close()
      throw error
    }
  )
  const scope = {
    db: host.db,
    stateDirectory,
    store: attachments,
    conversationId: intent.conversationId,
    contextGeneration: intent.contextGeneration
  }
  const targetBindingDigest = createHash('sha256')
    .update('synthetic-benchmark-recipient')
    .digest('hex')
  async function run(lane: 'export' | 'projection', signal: AbortSignal) {
    let integrity = true,
      mandatoryConstraintsPreserved = false,
      toolSeen = false,
      projectedConstraintExact = lane === 'export'
    if (lane === 'projection') {
      const prepared = createConversationPreparationRows({
        ...scope,
        snapshot,
        targetBindingDigest,
        maxBytes: 1024 * 1024,
        signal,
        projection: 'tools'
      })
      let count = 0
      for await (const { original, representation } of prepared.rows) {
        count++
        if (representation.representation === 'exact') {
          integrity &&=
            typeof representation.text === 'string' &&
            createHash('sha256').update(representation.text).digest('hex') ===
              original.version.sha256
        }
        if (original.version.source.sequence === fixture.sourceCount) {
          toolSeen =
            original.byteLength === toolRowBytes &&
            representation.representation === 'summarized' &&
            representation.spans.length > 0
        }
        if (representation.text?.includes(BENCHMARK_CONSTRAINT)) {
          projectedConstraintExact =
            representation.representation === 'exact' &&
            createHash('sha256').update(representation.text).digest('hex') ===
              original.version.sha256
        }
      }
      integrity &&= count === fixture.sourceCount && toolSeen && projectedConstraintExact
    }
    // Independently stream every original. This audit is included in elapsed time.
    let count = 0
    for await (const row of readConversationPreparationSourceRows(
      host.db,
      snapshot.ownerId,
      signal
    )) {
      const exported = await exportConversationContext({
        ...scope,
        signal,
        sources: [
          {
            segmentId: row.segmentId,
            pinOwnerId: snapshot.ownerId,
            source: row.version.source,
            decision: 'include',
            critical: row.version.source.sequence !== fixture.sourceCount
          }
        ],
        disclosure: {
          targetBindingDigest,
          resolve: () => ({
            version: row.version,
            contextGeneration: intent.contextGeneration,
            targetBindingDigest,
            action: 'include',
            reason: 'user-policy',
            critical: row.version.source.sequence !== fixture.sourceCount
          })
        }
      })
      for await (const source of streamConversationExportRows({
        ...scope,
        signal,
        artifact: exported.artifact,
        rows: exported.rows
      })) {
        const hash = createHash('sha256'),
          decoder = new TextDecoder('utf-8', { fatal: true })
        let bytes = 0,
          tail = ''
        for await (const chunk of source.chunks) {
          hash.update(chunk)
          bytes += chunk.byteLength
          tail = (tail + decoder.decode(chunk, { stream: true })).slice(-512)
        }
        tail += decoder.decode()
        integrity &&= hash.digest('hex') === row.version.sha256 && bytes === row.byteLength
        if (row.version.source.sequence === fixture.sourceCount) {
          integrity &&= bytes === toolRowBytes && tail.includes('日本語🙂終端')
        }
        if (tail.includes(BENCHMARK_CONSTRAINT)) {
          mandatoryConstraintsPreserved = true
        }
        count++
      }
    }
    return {
      status: 'completed',
      integrity: integrity && count === fixture.sourceCount && mandatoryConstraintsPreserved,
      mandatoryConstraintsPreserved: mandatoryConstraintsPreserved && projectedConstraintExact,
      toolByteLength: toolRowBytes,
      nativeAcceptance: 'not-run',
      sourceCount: count,
      verification:
        'Actual frozen canonical UTF-8/SHA audit included; projection is source-backed tool working state, not native delivery'
    }
  }
  return {
    run,
    close: fixture.close,
    transientPins: () =>
      Number(
        host.db
          .prepare(
            "SELECT COUNT(*) n FROM journal_epoch_pins WHERE owner_id LIKE 'conversation-export-read:%'"
          )
          .get()?.n ?? 0
      ),
    claimCount: () =>
      Number(
        host.db.prepare('SELECT COUNT(*) n FROM conversation_attachment_claims').get()?.n ?? 0
      ),
    dispatchCount: () =>
      Number(
        host.db
          .prepare(
            "SELECT COUNT(*) n FROM journal_rows WHERE json_extract(row_json,'$.kind')='dispatch'"
          )
          .get()?.n ?? 0
      )
  }
}
