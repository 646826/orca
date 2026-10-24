import { MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS } from '../agent-session-journal/journal-row-schema'
import type Database from '../../sqlite/sync-database'
import type {
  ConversationSourceBoundary,
  ConversationSwitchIntent
} from '../../../shared/conversation-record'
import { readConversationRowOrigins } from './conversation-origin-rows'

/** Inspect causal metadata outside writer queues; canonical rows remain the only history. */
export async function verifyConversationCandidateReadback(
  db: Database.Database,
  intent: ConversationSwitchIntent,
  readback: readonly ConversationSourceBoundary[],
  signal: AbortSignal
): Promise<boolean> {
  if (db.isTransaction) {
    throw new Error('Candidate readback cannot scan under a write transaction')
  }
  for (const boundary of readback) {
    const before =
      intent.candidateBaseline.find(
        (entry) => entry.sessionId === boundary.sessionId && entry.epoch === boundary.epoch
      )?.endSequence ?? 0
    if (boundary.sessionId !== intent.targetSessionId || boundary.endSequence < before) {
      return false
    }
    let sequence = before
    while (sequence < boundary.endSequence) {
      signal.throwIfAborted()
      const rows = db
        .prepare(`SELECT seq,json_extract(row_json,'$.kind') kind,
        CASE WHEN json_extract(row_json,'$.kind')='lifecycle-batch' THEN json_array_length(row_json,'$.mutations') ELSE 0 END mutations
        FROM journal_rows WHERE session_id=? AND epoch=? AND seq>? AND seq<=? ORDER BY seq LIMIT 128`)
        .all(boundary.sessionId, boundary.epoch, sequence, boundary.endSequence)
      if (!rows.length) {
        return false
      }
      for (const row of rows) {
        if (
          row.seq !== sequence + 1 ||
          typeof row.mutations !== 'number' ||
          !Number.isSafeInteger(row.mutations) ||
          row.mutations < 0 ||
          row.mutations > MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS
        ) {
          return false
        }
        if (row.kind === 'queue') {
          sequence = row.seq
          continue
        }
        try {
          const origins = readConversationRowOrigins(db, {
            sessionId: boundary.sessionId,
            epoch: boundary.epoch,
            sequence: row.seq
          })
          const paths = new Set([
            '$',
            ...Array.from({ length: row.mutations }, (_, index) => `$.mutations[${index}]`)
          ])
          if (
            origins.length !== paths.size ||
            origins.some(
              ({ atomPath, origin }) =>
                !paths.delete(atomPath) ||
                origin.segmentId !== intent.candidateSegmentId ||
                origin.conversationId !== intent.conversationId ||
                origin.contextGeneration !== intent.contextGeneration ||
                origin.nativeBindingGeneration !== intent.nativeBindingGeneration
            )
          ) {
            return false
          }
        } catch {
          return false
        }
        sequence = row.seq
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  return intent.candidateBaseline.every((before) =>
    readback.some(
      (boundary) =>
        boundary.sessionId === before.sessionId &&
        boundary.epoch === before.epoch &&
        boundary.endSequence >= before.endSequence
    )
  )
}
