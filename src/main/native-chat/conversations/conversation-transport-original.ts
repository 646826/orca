import { createHash } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { isConversationDeliveryEvidence } from '../../../shared/conversation-wire'
import type { ConversationSourceRef } from '../../../shared/conversation-record'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { parseJournalRow } from '../agent-session-journal/journal-row-schema'
import { readPinnedQueuedMessageEvidence } from '../agent-session-journal/queued-message-origin'
import { readConversationTransfer } from './conversation-trigger-reservation'
import { readConversationDeliveryPlan } from './conversation-delivery-plan'
import { readConversationManifest } from './conversation-context-coverage'
import { conversationContextEnvelope } from './conversation-context-envelope'
import {
  conversationContextDigest,
  conversationManifestIntegrity
} from './conversation-context-consent'
import { readSegments, readSwitchIntent } from './conversation-read-model'

export const MAX_TRANSPORT_ROW_BYTES = 1024 * 1024
export type ConversationTransportScope = { conversationId: string; contextGeneration: number }

export function readConversationTransportOriginal(
  db: Database.Database,
  scope: ConversationTransportScope,
  sessionId: string,
  transferId: string
) {
  const transfer = readConversationTransfer(db, transferId)
  if (!transfer || !['appended', 'accepted'].includes(transfer.state)) {
    throw new Error('Transport projection reservation is unavailable')
  }
  const binding = transfer.binding
  const intent = readSwitchIntent(db, binding.operationKey)
  const segment = readSegments(db, scope.conversationId).find(
    (entry) => entry.segmentId === binding.candidateSegmentId
  )
  const draft = readPinnedQueuedMessageEvidence(db, {
    ownerId: `conversation-transfer:${binding.transferId}`,
    sourceSessionId: binding.queueSessionId,
    messageId: binding.messageId,
    fingerprint: binding.sourceFingerprint,
    maxBytes: MAX_TRANSPORT_ROW_BYTES
  })
  const plan = readConversationDeliveryPlan(db, binding.deliveryPlanId)
  const manifest = readConversationManifest(db, binding.manifestId)
  if (
    binding.kind !== 'trigger' ||
    binding.targetSessionId !== sessionId ||
    binding.conversationId !== scope.conversationId ||
    binding.contextGeneration !== scope.contextGeneration ||
    intent?.phase !== 'activated' ||
    intent.conversationId !== scope.conversationId ||
    intent.candidateSegmentId !== binding.candidateSegmentId ||
    intent.targetSessionId !== sessionId ||
    intent.manifestId !== binding.manifestId ||
    intent.contextGeneration !== binding.contextGeneration ||
    intent.nativeBindingGeneration !== binding.nativeBindingGeneration ||
    intent.activationFence !== binding.candidateGeneration ||
    !intent.deliveryReceiptId ||
    segment?.lifecycle !== 'activated' ||
    segment.sessionId !== sessionId ||
    segment.contextGeneration !== scope.contextGeneration ||
    segment.nativeBindingGeneration !== binding.nativeBindingGeneration ||
    !draft ||
    draft.body.role !== 'user' ||
    draft.body.command ||
    draft.fingerprint !== binding.sourceFingerprint ||
    agentSessionSendBodyFingerprint(binding.queueSessionId, draft.body) !==
      binding.sourceFingerprint ||
    !plan ||
    plan.operationKey !== binding.operationKey ||
    plan.targetSessionId !== sessionId ||
    plan.manifestId !== binding.manifestId ||
    plan.manifestDigest !== binding.manifestDigest ||
    plan.contextGeneration !== binding.contextGeneration ||
    plan.nativeBindingGeneration !== binding.nativeBindingGeneration ||
    !manifest ||
    manifest.digest !== binding.manifestDigest ||
    manifest.conversationId !== scope.conversationId ||
    manifest.contextGeneration !== binding.contextGeneration ||
    manifest.target.sessionId !== sessionId ||
    manifest.target.nativeBindingGeneration !== binding.nativeBindingGeneration ||
    !conversationManifestIntegrity(manifest)
  ) {
    throw new Error('Transport projection provenance changed')
  }
  const accepted = db
    .prepare('SELECT plan_id,evidence_json FROM conversation_delivery_receipts WHERE receipt_id=?')
    .get(intent.deliveryReceiptId)
  const evidence: unknown =
    typeof accepted?.evidence_json === 'string' ? JSON.parse(accepted.evidence_json) : null
  if (
    accepted?.plan_id !== binding.deliveryPlanId ||
    !isConversationDeliveryEvidence(evidence) ||
    evidence.deliveryReceiptId !== intent.deliveryReceiptId ||
    evidence.operationKey !== binding.operationKey ||
    evidence.manifestId !== binding.manifestId ||
    evidence.targetSessionId !== sessionId ||
    evidence.contextGeneration !== binding.contextGeneration ||
    evidence.activationFence !== binding.candidateGeneration ||
    evidence.nativeBindingGeneration !== binding.nativeBindingGeneration ||
    segment.activationFence !== binding.candidateGeneration
  ) {
    throw new Error('Transport projection acceptance is unavailable')
  }
  const envelope = conversationContextEnvelope(manifest, plan.inlineDeltaKeys)
  if (Buffer.byteLength(envelope) > MAX_TRANSPORT_ROW_BYTES) {
    throw new Error('Transport projection envelope exceeds its bound')
  }
  const rowByteLimit =
    MAX_TRANSPORT_ROW_BYTES +
    Buffer.byteLength(JSON.stringify({ type: 'text', text: envelope })) +
    1
  const body: AgentJournalMessageItem = {
    ...draft.body,
    blocks: [{ type: 'text', text: envelope }, ...draft.body.blocks]
  }
  if (
    createHash('sha256').update(envelope).digest('hex') !== plan.envelopeDigest ||
    agentSessionSendBodyFingerprint(sessionId, body) !== binding.targetFingerprint
  ) {
    throw new Error('Transport projection envelope changed')
  }
  const input = db
    .prepare(
      'SELECT submission_id,payload_fingerprint,epoch FROM conversation_delivery_inputs WHERE plan_id=?'
    )
    .get(plan.planId)
  if (
    input?.submission_id !== binding.targetSubmissionId ||
    input.payload_fingerprint !== binding.targetFingerprint ||
    typeof input.epoch !== 'string'
  ) {
    throw new Error('Transport projection native input is unavailable')
  }
  const submissions = db
    .prepare(`SELECT CASE WHEN octet_length(row_json)<=? THEN row_json END row_json FROM journal_rows
    WHERE session_id=? AND epoch=? AND json_extract(row_json,'$.kind')='submission'
    AND json_extract(row_json,'$.clientMessageId')=? LIMIT 2`)
    .all(rowByteLimit, sessionId, input.epoch, binding.targetSubmissionId)
  const raw = submissions[0]?.row_json
  const submission = typeof raw === 'string' ? parseJournalRow(raw) : null
  if (
    typeof raw !== 'string' ||
    submissions.length !== 1 ||
    !submission?.ok ||
    submission.row.kind !== 'submission' ||
    submission.row.payloadFingerprint !== binding.targetFingerprint ||
    submission.row.queuedMessageId !== undefined ||
    submission.row.fence !== plan.runtimeFence ||
    conversationContextDigest(submission.row.body) !== conversationContextDigest(body) ||
    conversationContextDigest(submission.row.options ?? null) !== binding.targetOptionsDigest
  ) {
    throw new Error('Transport projection original submission is unavailable')
  }
  return {
    binding,
    original: draft.body,
    body,
    epoch: input.epoch,
    runtimeFence: plan.runtimeFence,
    rowByteLimit,
    raw,
    row: submission.row
  }
}

export function readConversationTransportSubmissionOriginal(
  db: Database.Database,
  scope: ConversationTransportScope,
  source: ConversationSourceRef
) {
  if (
    source.batchIndex !== undefined ||
    source.itemId !== undefined ||
    source.itemRevision !== undefined
  ) {
    return null
  }
  // No trigger for this target means no transport proof; avoid parsing unrelated large rows.
  if (
    !db
      .prepare(
        "SELECT 1 FROM conversation_trigger_reservations WHERE target_session_id=? AND kind='trigger' LIMIT 1"
      )
      .get(source.sessionId)
  ) {
    return null
  }
  const matches = db
    .prepare(`SELECT r.transfer_id FROM journal_rows j
    JOIN conversation_trigger_reservations r ON r.target_session_id=j.session_id
    AND r.target_submission_id=CASE WHEN json_valid(j.row_json) THEN json_extract(j.row_json,'$.clientMessageId') END AND r.kind='trigger'
    WHERE j.session_id=? AND j.epoch=? AND j.seq=? AND CASE WHEN json_valid(j.row_json) THEN json_extract(j.row_json,'$.kind') END='submission' LIMIT 2`)
    .all(source.sessionId, source.epoch, source.sequence)
  if (!matches.length) {
    return null
  }
  const id = matches[0]?.transfer_id
  if (matches.length !== 1 || typeof id !== 'string' || id.length > 4096) {
    throw new Error('Transport projection submission identity is ambiguous')
  }
  const proof = readConversationTransportOriginal(db, scope, source.sessionId, id)
  if (proof.row.epoch !== source.epoch || proof.row.seq !== source.sequence) {
    throw new Error('Transport projection submission coordinates changed')
  }
  return proof
}
