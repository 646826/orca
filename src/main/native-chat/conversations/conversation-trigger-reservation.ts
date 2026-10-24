import {
  assertQueuedDraftCurrentGeneration,
  pinQueuedMessageEvidence
} from '../agent-session-journal/queued-message-origin'
import { assertConversationContinuationReceipt } from './conversation-continuation-authority'
import type { JournalSubmissionRow } from '../agent-session-journal/journal-row-schema'
import type Database from '../../sqlite/sync-database'
import type { JournalOperationReceipt } from '../agent-session-journal/journal-row-writer'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'
import { parseJournalRow } from '../agent-session-journal/journal-row-schema'
import {
  readConversation,
  readSwitchIntent,
  readSegments,
  readParticipant
} from './conversation-read-model'
import { readConversationManifest } from './conversation-context-coverage'
import {
  assertConversationManifestAuthority,
  verifyConversationContextEvidence,
  type ConversationContextEvidenceReader
} from './conversation-context-authority'
import { assertConversationManifestIndexAuthorization } from './conversation-context-index-authority'
import { conversationContextDigest } from './conversation-context-consent'
import {
  conversationTriggerBindingSchema,
  conversationTriggerStateSchema,
  type ConversationTriggerBinding,
  type ConversationTriggerReservation
} from './conversation-trigger-schema'
export type ConversationTriggerAuthority = {
  readPreparationEvidence: ConversationContextEvidenceReader
  readSourceCard: (sessionId: string, messageId: string) => QueuedMessageRow | null
  /** Trusted host DB resolver; verifies original draft, target envelope and retained attachment claims. */
  verifyTriggerClaims: (
    db: Database.Database,
    binding: ConversationTriggerBinding,
    row?: JournalSubmissionRow
  ) => boolean
}
export function readConversationTransfer(
  db: Database.Database,
  transferId: string
): ConversationTriggerReservation | null {
  const row = db
    .prepare('SELECT * FROM conversation_trigger_reservations WHERE transfer_id=?')
    .get(transferId)
  if (!row) {
    return null
  }
  if (typeof row.binding_json !== 'string') {
    throw new Error('Corrupt trigger binding')
  }
  const binding = conversationTriggerBindingSchema.parse(JSON.parse(row.binding_json))
  if (
    binding.transferId !== transferId ||
    binding.operationKey !== row.operation_key ||
    binding.kind !== row.kind ||
    binding.queueSessionId !== row.queue_session_id ||
    binding.messageId !== row.message_id ||
    binding.targetSessionId !== row.target_session_id ||
    binding.targetSubmissionId !== row.target_submission_id
  ) {
    throw new Error('Corrupt trigger binding coordinates')
  }
  return {
    binding,
    state: conversationTriggerStateSchema.parse(row.state)
  }
}
export function assertConversationTransferSourceScope(
  db: Database.Database,
  b: Pick<ConversationTriggerBinding, 'queueSessionId' | 'conversationId' | 'contextGeneration'>
): void {
  const source = readParticipant(db, b.queueSessionId)
  if (
    !source ||
    source.conversationId !== b.conversationId ||
    source.contextGeneration !== b.contextGeneration
  ) {
    throw new Error('Trigger source scope changed')
  }
}
function assertAuthority(
  db: Database.Database,
  b: ConversationTriggerBinding,
  authority: ConversationTriggerAuthority
): void {
  if (!db.isTransaction) {
    throw new Error('Trigger requires the host transaction')
  }
  assertConversationTransferSourceScope(db, b)
  assertQueuedDraftCurrentGeneration(db, { sessionId: b.queueSessionId, messageId: b.messageId })
  const intent = readSwitchIntent(db, b.operationKey),
    conversation = readConversation(db, b.conversationId)
  const segment = readSegments(db, b.conversationId).find(
    (s) => s.segmentId === b.candidateSegmentId
  )
  if (
    !intent ||
    !conversation ||
    (b.kind === 'trigger'
      ? conversation.pendingOperationKey !== b.operationKey
      : conversation.activeSegmentId !== b.candidateSegmentId ||
        conversation.activationFence !== b.candidateGeneration) ||
    intent.conversationId !== b.conversationId ||
    intent.candidateSegmentId !== b.candidateSegmentId ||
    intent.targetSessionId !== b.targetSessionId ||
    intent.activationFence !== b.candidateGeneration ||
    intent.contextGeneration !== b.contextGeneration ||
    intent.nativeBindingGeneration !== b.nativeBindingGeneration ||
    intent.manifestId !== b.manifestId ||
    (b.kind === 'trigger'
      ? !['prepared', 'delivering'].includes(intent.phase)
      : intent.phase !== 'activated') ||
    segment?.lifecycle !== (b.kind === 'trigger' ? 'candidate' : 'activated') ||
    segment.sessionId !== b.targetSessionId ||
    segment.contextGeneration !== b.contextGeneration ||
    segment.activationFence !== b.candidateGeneration ||
    segment.nativeBindingGeneration !== b.nativeBindingGeneration
  ) {
    throw new Error('Trigger switch authority changed')
  }
  const target = readParticipant(db, b.targetSessionId)
  if (
    conversation.contextGeneration !== b.contextGeneration ||
    !target ||
    target.conversationId !== b.conversationId ||
    target.contextGeneration !== b.contextGeneration ||
    target.nativeBindingGeneration !== b.nativeBindingGeneration ||
    (b.kind === 'queued-continuation' &&
      (target.state !== 'active' || conversation.pendingOperationKey !== null))
  ) {
    throw new Error('Transfer active generation changed')
  }
  const manifest = readConversationManifest(db, b.manifestId)
  if (
    !manifest ||
    manifest.digest !== b.manifestDigest ||
    manifest.target.sessionId !== b.targetSessionId ||
    manifest.contextGeneration !== b.contextGeneration ||
    manifest.target.nativeBindingGeneration !== b.nativeBindingGeneration
  ) {
    throw new Error('Trigger manifest changed')
  }
  if (b.kind === 'trigger') {
    assertConversationManifestAuthority(db, manifest)
    assertConversationManifestIndexAuthorization(db, manifest)
    verifyConversationContextEvidence(db, manifest, authority.readPreparationEvidence)
  } else {
    assertConversationContinuationReceipt(db, b, intent)
  }
  if (!authority.verifyTriggerClaims(db, b)) {
    throw new Error('Trigger envelope or attachment claims unverified')
  }
}
export function reserveConversationTrigger(
  db: Database.Database,
  input: ConversationTriggerBinding,
  authority: ConversationTriggerAuthority
): ConversationTriggerReservation {
  const binding = conversationTriggerBindingSchema.parse(input)
  assertAuthority(db, binding, authority)
  const existing = readConversationTransfer(db, binding.transferId)
  if (existing) {
    if (conversationContextDigest(existing.binding) !== conversationContextDigest(binding)) {
      throw new Error('Trigger identity conflict')
    }
    return existing
  }
  const draft = authority.readSourceCard(binding.queueSessionId, binding.messageId)
  if (
    !draft ||
    draft.state !== binding.expectedQueueState ||
    draft.fingerprint !== binding.sourceFingerprint ||
    binding.messageId === binding.targetSubmissionId ||
    binding.queueSessionId === binding.targetSessionId
  ) {
    throw new Error('Trigger draft changed')
  }
  pinQueuedMessageEvidence(db, {
    ownerId: `conversation-transfer:${binding.transferId}`,
    sourceSessionId: binding.queueSessionId,
    messageId: binding.messageId,
    fingerprint: binding.sourceFingerprint,
    queueOrder: { position: draft.position, queuedAt: draft.queuedAt }
  })
  db.prepare(
    "INSERT INTO conversation_trigger_reservations VALUES(?,?,?,?,?,?,?,?,'reserved')"
  ).run(
    binding.transferId,
    binding.kind,
    binding.operationKey,
    binding.queueSessionId,
    binding.messageId,
    binding.targetSessionId,
    binding.targetSubmissionId,
    JSON.stringify(binding)
  )
  return { binding, state: 'reserved' }
}
/** Composed with the normal target submission receipt; never dispatches or enters a session queue. */
export function conversationTriggerAppendReceipt(input: {
  binding: ConversationTriggerBinding
  originSessionId: string
  authority: ConversationTriggerAuthority
  now: number
  sourceWithdrawal: { epoch: string; sequence: number }
}): JournalOperationReceipt {
  return {
    write(db, row) {
      const b = input.binding
      if (input.originSessionId !== b.targetSessionId) {
        throw new Error('Trigger receipt crossed sessions')
      }
      assertAuthority(db, b, input.authority)
      const reservation = readConversationTransfer(db, b.transferId)
      if (
        !reservation ||
        reservation.state !== 'reserved' ||
        conversationContextDigest(reservation.binding) !== conversationContextDigest(b) ||
        row?.kind !== 'submission' ||
        row.clientMessageId !== b.targetSubmissionId ||
        row.payloadFingerprint !== b.targetFingerprint ||
        row.queuedMessageId !== undefined
      ) {
        throw new Error('Trigger submission is not reserved')
      }
      if (!input.authority.verifyTriggerClaims(db, b, row)) {
        throw new Error('Trigger row claims unverified')
      }
      const stored = db
        .prepare('SELECT 1 present FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?')
        .get(b.targetSessionId, row.epoch, row.seq)
      if (!stored) {
        throw new Error('Trigger target row missing')
      }
      const source = db
        .prepare(`SELECT row_json FROM journal_rows
        WHERE session_id=? AND epoch=? AND seq=?`)
        .get(b.queueSessionId, input.sourceWithdrawal.epoch, input.sourceWithdrawal.sequence)
      const withdrawal =
        typeof source?.row_json === 'string' ? parseJournalRow(source.row_json) : null
      if (
        !withdrawal?.ok ||
        withdrawal.row.kind !== 'queue' ||
        withdrawal.row.messageId !== b.messageId ||
        withdrawal.row.change.op !== 'withdrawn'
      ) {
        throw new Error('Trigger source withdrawal missing')
      }
      pinQueuedMessageEvidence(db, {
        ownerId: `conversation-transfer:${b.transferId}`,
        sourceSessionId: b.queueSessionId,
        messageId: b.messageId,
        fingerprint: b.sourceFingerprint
      })
      db.prepare(
        "UPDATE conversation_trigger_reservations SET state='appended' WHERE transfer_id=?"
      ).run(b.transferId)
    },
    committed: () => {}
  }
}

export function readConversationTrigger(
  db: Database.Database,
  operationKey: string
): ConversationTriggerReservation | null {
  const row = db
    .prepare(
      "SELECT transfer_id FROM conversation_trigger_reservations WHERE operation_key=? AND kind='trigger'"
    )
    .get(operationKey)
  return typeof row?.transfer_id === 'string' ? readConversationTransfer(db, row.transfer_id) : null
}

/** Extra gate only: the existing journal hand-over/replay guard remains mandatory. */
export function canDispatchConversationTransfer(
  db: Database.Database,
  input: { transferId: string; targetSessionId: string; targetSubmissionId: string },
  authority: ConversationTriggerAuthority
): boolean {
  try {
    const transfer = readConversationTransfer(db, input.transferId)
    if (
      !transfer ||
      transfer.state !== 'appended' ||
      transfer.binding.targetSessionId !== input.targetSessionId ||
      transfer.binding.targetSubmissionId !== input.targetSubmissionId
    ) {
      return false
    }
    assertAuthority(db, transfer.binding, authority)
    return true
  } catch {
    return false
  }
}
