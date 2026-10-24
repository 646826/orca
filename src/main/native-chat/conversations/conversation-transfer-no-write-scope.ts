import type Database from '../../sqlite/sync-database'
import { parseJournalRow } from '../agent-session-journal/journal-row-schema'
import { readJournalSessionEpoch } from '../agent-session-journal/journal-row-table'
import { readPinnedQueuedMessageEvidence } from '../agent-session-journal/queued-message-origin'
import { conversationContextDigest } from './conversation-context-consent'
import { readConversationTransfer } from './conversation-trigger-reservation'
import {
  readConversation,
  readParticipant,
  readSwitchIntent,
  readConversationSegment
} from './conversation-read-model'
import type { ConversationTriggerBinding } from './conversation-trigger-schema'
import {
  nativeScope,
  historicalNativeScope,
  sourceNativeScope
} from './conversation-transfer-no-write-native'
export { nativeScope } from './conversation-transfer-no-write-native'

import {
  MAX_PROOF_BYTES,
  MAX_SCOPE_ROWS,
  MAX_SCOPE_BYTES,
  MAX_ROW_BYTES,
  type HandoverScope
} from './conversation-transfer-no-write-schema'

export function transfer(db: Database.Database, transferId: string) {
  const bounded = db
    .prepare(`SELECT octet_length(binding_json) bytes
    FROM conversation_trigger_reservations WHERE transfer_id=?`)
    .get(transferId)
  if (typeof bounded?.bytes !== 'number' || bounded.bytes > MAX_PROOF_BYTES) {
    return null
  }
  return readConversationTransfer(db, transferId)
}

export function originalDigest(
  db: Database.Database,
  binding: ConversationTriggerBinding
): string | null {
  const original = readPinnedQueuedMessageEvidence(db, {
    ownerId: `conversation-transfer:${binding.transferId}`,
    sourceSessionId: binding.queueSessionId,
    messageId: binding.messageId,
    fingerprint: binding.sourceFingerprint
  })
  return original ? conversationContextDigest(original) : null
}

export function storedRow(db: Database.Database, sessionId: string, epoch: string, seq: number) {
  const row = db
    .prepare(`SELECT CASE WHEN octet_length(row_json)<=${MAX_ROW_BYTES} THEN row_json END row_json FROM journal_rows
    WHERE session_id=? AND epoch=? AND seq=?`)
    .get(sessionId, epoch, seq)
  const parsed = typeof row?.row_json === 'string' ? parseJournalRow(row.row_json) : null
  return parsed?.ok && parsed.row.epoch === epoch && parsed.row.seq === seq ? parsed.row : null
}

export function boundedWindow(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  first: number
): boolean {
  if (
    !Number.isSafeInteger(first) ||
    first < 1 ||
    first > Number.MAX_SAFE_INTEGER - MAX_SCOPE_ROWS
  ) {
    return false
  }
  const last = db
    .prepare(
      'SELECT seq FROM journal_rows WHERE session_id=? AND epoch=? ORDER BY seq DESC LIMIT 1'
    )
    .get(sessionId, epoch)?.seq
  if (typeof last !== 'number' || last < first || last - first >= MAX_SCOPE_ROWS) {
    return false
  }
  const bytes = db
    .prepare(`SELECT count(*) count,sum(octet_length(row_json)) total,max(octet_length(row_json)) largest
    FROM journal_rows WHERE session_id=? AND epoch=? AND seq>=? AND seq<=?`)
    .get(sessionId, epoch, first, last)
  return (
    bytes?.count === last - first + 1 &&
    typeof bytes?.total === 'number' &&
    bytes.total <= MAX_SCOPE_BYTES &&
    typeof bytes.largest === 'number' &&
    bytes.largest <= MAX_ROW_BYTES
  )
}

export function acceptedEvidence(
  db: Database.Database,
  binding: ConversationTriggerBinding,
  scope: HandoverScope
): boolean {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM conversation_delivery_receipts r LEFT JOIN conversation_delivery_inputs i ON i.plan_id=r.plan_id
        WHERE r.plan_id=? AND (?='trigger' OR i.submission_id IS NULL OR i.submission_id=?) LIMIT 1`)
      .get(binding.deliveryPlanId, binding.kind, binding.targetSubmissionId) ||
    db
      .prepare(`SELECT 1 FROM journal_rows
      WHERE session_id=? AND epoch=? AND seq>=? AND seq<? AND (
        (json_extract(row_json,'$.kind')='dispatch' AND json_extract(row_json,'$.clientMessageId')=?
          AND json_extract(row_json,'$.state')='accepted') OR
        json_extract(row_json,'$.echoOf')=? OR EXISTS(
          SELECT 1 FROM json_each(journal_rows.row_json,'$.mutations')
          WHERE json_extract(value,'$.echoOf')=?)) LIMIT 1`)
      .get(
        binding.targetSessionId,
        scope.targetEpoch,
        scope.targetSubmissionSequence,
        scope.targetSubmissionSequence + MAX_SCOPE_ROWS,
        binding.targetSubmissionId,
        binding.targetSubmissionId,
        binding.targetSubmissionId
      )
  )
}

export function latestDispatch(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  submissionId: string,
  first: number,
  beforeSequence = first + MAX_SCOPE_ROWS
) {
  const row = db
    .prepare(`SELECT seq,row_json FROM journal_rows
    WHERE session_id=? AND epoch=? AND seq>=? AND seq<? AND json_extract(row_json,'$.kind')='dispatch'
      AND json_extract(row_json,'$.clientMessageId')=? ORDER BY seq DESC LIMIT 1`)
    .get(sessionId, epoch, first, beforeSequence, submissionId)
  const parsed = typeof row?.row_json === 'string' ? parseJournalRow(row.row_json) : null
  return parsed?.ok &&
    parsed.row.kind === 'dispatch' &&
    parsed.row.epoch === epoch &&
    parsed.row.seq === row?.seq
    ? parsed.row
    : null
}

function currentScopeRecordsBounded(
  db: Database.Database,
  binding: ConversationTriggerBinding
): boolean {
  return (
    [
      ['conversations', 'conversation_id', binding.conversationId],
      ['conversation_participants', 'session_id', binding.targetSessionId],
      ['conversation_switch_intents', 'operation_key', binding.operationKey],
      ['conversation_segments', 'segment_id', binding.candidateSegmentId]
    ] as const
  ).every(([table, key, id]) => {
    const bytes = db
      .prepare(`SELECT octet_length(record_json) bytes FROM ${table} WHERE ${key}=?`)
      .get(id)?.bytes
    return typeof bytes === 'number' && bytes <= MAX_ROW_BYTES
  })
}

function isOnlyPendingAttempt(db: Database.Database, scope: HandoverScope): boolean {
  const pending = db
    .prepare(`SELECT count(*) count,min(seq) sequence FROM journal_rows
    WHERE session_id=? AND epoch=? AND seq>=? AND seq<?
    AND json_extract(row_json,'$.kind')='dispatch' AND json_extract(row_json,'$.clientMessageId')=?
    AND json_extract(row_json,'$.state')='pending'`)
    .get(
      scope.targetSessionId,
      scope.targetEpoch,
      scope.targetSubmissionSequence,
      scope.targetSubmissionSequence + MAX_SCOPE_ROWS,
      scope.targetSubmissionId
    )
  return (
    scope.recoveryAttempt === 0 &&
    pending?.count === 1 &&
    pending.sequence === scope.handoverSequence
  )
}

export function matchesScope(
  db: Database.Database,
  scope: HandoverScope,
  historical = false
): boolean {
  const reservation = transfer(db, scope.transferId)
  const binding = reservation?.binding
  const native = binding && !historical ? nativeScope(db, binding, scope.runtimeFence) : null
  const sourceIdentity = binding && sourceNativeScope(db, binding)
  if (
    !binding ||
    !currentScopeRecordsBounded(db, binding) ||
    !['appended', 'uncertain', 'proven-no-effect'].includes(reservation.state) ||
    binding.operationKey !== scope.operationKey ||
    binding.conversationId !== scope.conversationId ||
    binding.targetSessionId !== scope.targetSessionId ||
    binding.targetSubmissionId !== scope.targetSubmissionId ||
    binding.contextGeneration !== scope.contextGeneration ||
    binding.nativeBindingGeneration !== scope.nativeBindingGeneration ||
    binding.targetFingerprint !== scope.targetFingerprint ||
    binding.queueSessionId !== scope.sourceSessionId ||
    binding.messageId !== scope.sourceMessageId ||
    binding.sourceFingerprint !== scope.sourceFingerprint ||
    conversationContextDigest(binding) !== scope.bindingDigest ||
    (!historical && readJournalSessionEpoch(db, scope.targetSessionId) !== scope.targetEpoch) ||
    !boundedWindow(db, scope.targetSessionId, scope.targetEpoch, scope.targetSubmissionSequence) ||
    !isOnlyPendingAttempt(db, scope) ||
    originalDigest(db, binding) !== scope.sourceOriginalDigest ||
    !sourceIdentity ||
    sourceIdentity.sourceNativeBindingGeneration !== scope.sourceNativeBindingGeneration ||
    sourceIdentity.sourceRecordBirthDigest !== scope.sourceRecordBirthDigest ||
    sourceIdentity.sourceAccountBindingDigest !== scope.sourceAccountBindingDigest ||
    sourceIdentity.sourceNativeHandleDigest !== scope.sourceNativeHandleDigest ||
    (historical
      ? !historicalNativeScope(db, binding, scope)
      : !native ||
        native.nativeIdentityDigest !== scope.nativeIdentityDigest ||
        native.recordBirthDigest !== scope.recordBirthDigest ||
        native.accountBindingDigest !== scope.accountBindingDigest ||
        native.nativeHandleDigest !== scope.nativeHandleDigest) ||
    acceptedEvidence(db, binding, scope)
  ) {
    return false
  }
  const conversation = readConversation(db, scope.conversationId)
  const participant = readParticipant(db, scope.targetSessionId)
  const source = readParticipant(db, scope.sourceSessionId)
  const intent = readSwitchIntent(db, scope.operationKey)
  const segment = readConversationSegment(db, scope.conversationId, binding.candidateSegmentId)
  const runtimeFence = db
    .prepare(`SELECT json_extract(record_json,'$.lease.runtimeFence') fence
    FROM agent_session_records WHERE session_id=?`)
    .get(scope.targetSessionId)?.fence
  return (
    conversation?.contextGeneration === scope.contextGeneration &&
    participant?.conversationId === scope.conversationId &&
    participant.contextGeneration === scope.contextGeneration &&
    participant.nativeBindingGeneration === scope.nativeBindingGeneration &&
    source?.conversationId === scope.conversationId &&
    source.contextGeneration === scope.contextGeneration &&
    segment?.sessionId === scope.targetSessionId &&
    segment.contextGeneration === scope.contextGeneration &&
    segment.nativeBindingGeneration === scope.nativeBindingGeneration &&
    segment.activationFence === binding.candidateGeneration &&
    (historical || runtimeFence === scope.runtimeFence) &&
    intent?.contextGeneration === scope.contextGeneration &&
    intent.nativeBindingGeneration === scope.nativeBindingGeneration &&
    intent.targetSessionId === scope.targetSessionId &&
    intent.candidateSegmentId === binding.candidateSegmentId &&
    intent.activationFence === binding.candidateGeneration &&
    (binding.kind === 'trigger'
      ? conversation.pendingOperationKey === scope.operationKey &&
        segment.lifecycle === 'candidate' &&
        ['prepared', 'delivering', 'reconciliation-required'].includes(intent.phase)
      : conversation.activeSegmentId === binding.candidateSegmentId &&
        conversation.activationFence === binding.candidateGeneration &&
        conversation.pendingOperationKey === null &&
        participant.state === 'active' &&
        segment.lifecycle === 'activated' &&
        intent.phase === 'activated')
  )
}
