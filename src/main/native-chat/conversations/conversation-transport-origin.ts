import type Database from '../../sqlite/sync-database'
import type { ConversationEvidenceVersion } from '../../../shared/conversation-handoff'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import type { ConversationTriggerBinding } from './conversation-trigger-schema'
import { readConversationRowOrigins } from './conversation-origin-rows'
import { readConversationCapturedScope } from './conversation-origin-capture'

/** A repeated native item id is not authority to reuse an older transfer's transport proof. */
export function assertConversationTransportOrigin(
  db: Database.Database,
  source: ConversationEvidenceVersion['source'],
  row: JournalRow,
  atomPath: string,
  binding: ConversationTriggerBinding,
  deliveryFence: number
): void {
  const origin = readConversationRowOrigins(db, source).find(
    (entry) => entry.atomPath === atomPath
  )?.origin
  const captured = readConversationCapturedScope(db, source.sessionId, row, atomPath)
  if (
    !origin ||
    origin.segmentId !== binding.candidateSegmentId ||
    origin.conversationId !== binding.conversationId ||
    origin.contextGeneration !== binding.contextGeneration ||
    origin.nativeBindingGeneration !== binding.nativeBindingGeneration ||
    captured?.conversationId !== binding.conversationId ||
    captured.contextGeneration !== binding.contextGeneration ||
    captured.nativeBindingGeneration !== binding.nativeBindingGeneration
  ) {
    throw new Error('Transport projection captured origin changed')
  }
  const fact =
    atomPath === '$'
      ? row
      : row.kind === 'lifecycle-batch'
        ? row.mutations[Number(/^\$\.mutations\[(\d+)\]$/.exec(atomPath)?.[1])]
        : undefined
  if (!fact) {
    throw new Error('Transport projection atom is unavailable')
  }
  const providerItem = fact.kind === 'item' || fact.kind === 'tombstone'
  const fence = providerItem
    ? 'ownerFence' in fact && typeof fact.ownerFence === 'number'
      ? fact.ownerFence
      : undefined
    : row.fence
  const acquisition = (fence: number | undefined) =>
    fence === undefined
      ? null
      : db
          .prepare(
            'SELECT native_identity FROM conversation_origin_acquisitions WHERE session_id=? AND fence=?'
          )
          .get(source.sessionId, fence)?.native_identity
  const native = acquisition(deliveryFence)
  if (typeof native !== 'string' || acquisition(fence) !== native) {
    throw new Error('Transport projection acquisition changed')
  }
  if (
    providerItem &&
    (fact.kind !== 'item' ||
      fact.turnScope?.kind !== 'turn' ||
      !db
        .prepare(`SELECT 1 FROM conversation_origin_correlations
          WHERE session_id=? AND fence=? AND submission_id=? AND turn_key=? AND resolved=1`)
        .get(
          source.sessionId,
          deliveryFence,
          binding.targetSubmissionId,
          fact.turnScope.turnItemId
        ))
  ) {
    throw new Error('Transport projection native turn is unverified')
  }
}
