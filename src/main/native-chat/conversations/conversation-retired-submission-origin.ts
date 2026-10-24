import type Database from '../../sqlite/sync-database'
import { parseJournalRow, type JournalRow } from '../agent-session-journal/journal-row-schema'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  assertConversationOrigin,
  parseConversationOrigin,
  type ConversationOrigin
} from './conversation-origin'
import { readConversationEnrollmentOrigin } from './conversation-origin-capture'
import { conversationContextDigest } from './conversation-context-consent'
import { conversationTriggerBindingSchema } from './conversation-trigger-schema'
import {
  proofSchema,
  MAX_PROOF_BYTES,
  MAX_ROW_BYTES
} from './conversation-transfer-no-write-schema'

/** The same-transaction recovery receipt authenticates an exact original even after cancellation. */
export function readConversationRetiredSubmissionOrigin(
  db: Database.Database,
  sessionId: string,
  row: JournalRow
): ConversationOrigin | null {
  if (row.kind !== 'tombstone' || row.retireSubmission !== true) {
    return null
  }
  const identity = parseAgentJournalItemKey(row.itemId)
  if (identity?.provider !== 'orca') {
    return null
  }
  const saved = db
    .prepare(`SELECT r.transfer_id,c.proof_digest,
    CASE WHEN octet_length(c.proof_json)<=${MAX_PROOF_BYTES} THEN c.proof_json END proof_json,
    CASE WHEN octet_length(r.binding_json)<=32768 THEN r.binding_json END binding_json
    FROM conversation_trigger_reservations r JOIN conversation_transfer_recoveries c USING(transfer_id)
    WHERE r.target_session_id=? AND r.target_submission_id=? AND c.retirement_epoch=? AND c.retirement_sequence=?`)
    .get(sessionId, identity.clientMessageId, row.epoch, row.seq)
  if (!saved) {
    return null
  }
  if (typeof saved.proof_json !== 'string' || typeof saved.binding_json !== 'string') {
    throw new Error('Retired submission proof unavailable')
  }
  const proof = proofSchema.parse(JSON.parse(saved.proof_json))
  const binding = conversationTriggerBindingSchema.parse(JSON.parse(saved.binding_json))
  if (
    proof.transferId !== saved.transfer_id ||
    proof.targetSessionId !== sessionId ||
    proof.targetSubmissionId !== identity.clientMessageId ||
    conversationContextDigest(proof) !== saved.proof_digest ||
    conversationContextDigest(binding) !== proof.bindingDigest
  ) {
    throw new Error('Retired submission proof changed')
  }
  const original = db
    .prepare(`SELECT
    CASE WHEN octet_length(j.row_json)<=${MAX_ROW_BYTES} THEN j.row_json END row_json,
    o.session_id origin_session,CASE WHEN octet_length(o.origin_json)<=16384 THEN o.origin_json END origin_json
    FROM journal_rows j LEFT JOIN conversation_origin_rows o
      ON o.session_id=j.session_id AND o.epoch=j.epoch AND o.sequence=j.seq AND o.atom_path='$'
    WHERE j.session_id=? AND j.epoch=? AND j.seq=?`)
    .get(sessionId, proof.targetEpoch, proof.targetSubmissionSequence)
  const parsed = typeof original?.row_json === 'string' ? parseJournalRow(original.row_json) : null
  if (
    !parsed?.ok ||
    parsed.row.kind !== 'submission' ||
    parsed.row.clientMessageId !== proof.targetSubmissionId ||
    parsed.row.payloadFingerprint !== proof.targetFingerprint ||
    parsed.row.epoch !== proof.targetEpoch ||
    parsed.row.seq !== proof.targetSubmissionSequence
  ) {
    throw new Error('Retired submission source changed')
  }
  const origin =
    typeof original?.origin_json === 'string'
      ? parseConversationOrigin(JSON.parse(original.origin_json))
      : typeof original?.origin_session === 'string'
        ? null
        : readConversationEnrollmentOrigin(db, {
            sessionId,
            epoch: proof.targetEpoch,
            sequence: proof.targetSubmissionSequence
          })
  if (
    !origin ||
    origin.conversationId !== binding.conversationId ||
    origin.contextGeneration !== binding.contextGeneration ||
    origin.nativeBindingGeneration !== binding.nativeBindingGeneration ||
    origin.segmentId !== binding.candidateSegmentId
  ) {
    throw new Error('Retired submission origin unavailable')
  }
  assertConversationOrigin(db, sessionId, origin)
  return origin
}
