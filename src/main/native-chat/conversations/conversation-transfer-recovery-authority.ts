import { agentSessionLeaseAdmitsWriter } from '../../../shared/agent-session-lease-adjudication'
import { readJournalSessionEpoch } from '../agent-session-journal/journal-row-table'
import type Database from '../../sqlite/sync-database'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import type { ConversationTransferRecoveryScope } from '../../../shared/conversation-transfer-recovery'
import {
  assertQueuedDraftCurrentGeneration,
  readPinnedQueuedMessageEvidence
} from '../agent-session-journal/queued-message-origin'
import {
  agentSessionAttachmentReferences,
  agentSessionAttachmentStoreRoot
} from '../agent-session-attachments/agent-session-attachment-references'
import { conversationContextDigest } from './conversation-context-consent'
import {
  readHistoricalConversationTransferNoWrite,
  matchesConversationTransferNoWriteIdentity,
  matchesConversationTransferNoWriteSourceIdentity,
  type ConversationTransferNoWriteProof
} from './conversation-transfer-no-write'
import { readConversationTransfer } from './conversation-trigger-reservation'
import { readConversationTriggerAttachments } from './conversation-trigger-attachments'
import { ConversationRefusal } from './conversation-read-model'
import {
  assertGeneration,
  assertIntent,
  requireConversation,
  requireIntent
} from './conversation-store-transitions'

export function isConversationTransferRecoveryOwner(
  record: AgentSessionRecord | null | undefined,
  proof: ConversationTransferNoWriteProof,
  source: AgentSessionRecord | null | undefined
): boolean {
  const head = record && agentSessionProviderHandleChainHead(record.providerHandleChain)
  return Boolean(
    record &&
    head &&
    record.sessionId === proof.targetSessionId &&
    agentSessionLeaseAdmitsWriter(record.lease) &&
    record.lease.provenHandleLinkId === head.linkId &&
    matchesConversationTransferNoWriteIdentity(record, proof) &&
    isConversationTransferRecoverySource(source, proof)
  )
}

function isConversationTransferRecoverySource(
  record: AgentSessionRecord | null | undefined,
  proof: ConversationTransferNoWriteProof
): boolean {
  const head = record && agentSessionProviderHandleChainHead(record.providerHandleChain)
  return Boolean(
    record &&
    head &&
    !record.lease.unreconciled &&
    matchesConversationTransferNoWriteSourceIdentity(record, proof) &&
    (record.lease.claimStatus === 'live'
      ? agentSessionLeaseAdmitsWriter(record.lease) &&
        record.lease.provenHandleLinkId === head.linkId
      : record.lease.claimStatus === 'released' &&
        !record.lease.ownerProcess &&
        !record.lease.reservedSpawnToken &&
        !record.lease.handoffStage)
  )
}

export function readRecoveryTransfer(db: Database.Database, transferId: string) {
  const row = db
    .prepare(
      'SELECT octet_length(binding_json) bytes FROM conversation_trigger_reservations WHERE transfer_id=?'
    )
    .get(transferId)
  if (typeof row?.bytes !== 'number' || row.bytes > 32 * 1024) {
    throw new ConversationRefusal('corrupt-record')
  }
  return readConversationTransfer(db, transferId)
}

export function requireTransferRecoveryAuthority(
  db: Database.Database,
  request: ConversationTransferRecoveryScope,
  stateDirectory: string
) {
  const intent = requireIntent(db, request.operationKey)
  const conversation = requireConversation(db, intent.conversationId)
  assertGeneration(conversation, request)
  const transfer = readRecoveryTransfer(db, request.transferId)
  const proof = readHistoricalConversationTransferNoWrite(db, request.transferId)
  if (
    !transfer ||
    transfer.binding.operationKey !== request.operationKey ||
    !proof ||
    conversationContextDigest(proof) !== request.expectedProofDigest ||
    proof.recoveryAttempt !== request.expectedRecoveryAttempt ||
    readJournalSessionEpoch(db, proof.targetSessionId) !== request.expectedTargetEpoch ||
    intent.nativeBindingGeneration !== request.expectedNativeBindingGeneration
  ) {
    throw new ConversationRefusal('unverified-delivery')
  }
  const binding = transfer.binding
  if (binding.kind === 'trigger') {
    assertIntent(conversation, intent, request.expectedVersion)
    if (!['delivering', 'reconciliation-required'].includes(intent.phase)) {
      throw new ConversationRefusal('unverified-delivery')
    }
  } else if (
    intent.phase !== 'activated' ||
    intent.version !== request.expectedVersion ||
    intent.contextGeneration !== conversation.contextGeneration ||
    conversation.pendingOperationKey !== null ||
    conversation.activeSegmentId !== binding.candidateSegmentId ||
    conversation.activationFence !== binding.candidateGeneration
  ) {
    throw new ConversationRefusal('stale-generation')
  }
  const original = readPinnedQueuedMessageEvidence(db, {
    ownerId: `conversation-transfer:${binding.transferId}`,
    sourceSessionId: binding.queueSessionId,
    messageId: binding.messageId,
    fingerprint: binding.sourceFingerprint,
    maxBytes: 1024 * 1024
  })
  if (
    !original ||
    !original.queueOrder ||
    original.admittedAt === null ||
    !original.origin ||
    (original.origin.conversationId !== null &&
      (original.origin.conversationId !== conversation.conversationId ||
        original.origin.contextGeneration !== conversation.contextGeneration)) ||
    original.body.role !== 'user' ||
    original.body.command ||
    conversationContextDigest(original) !== proof.sourceOriginalDigest
  ) {
    throw new ConversationRefusal('missing-source')
  }
  assertQueuedDraftCurrentGeneration(db, {
    sessionId: binding.queueSessionId,
    messageId: binding.messageId
  })
  const claims = readConversationTriggerAttachments(db, binding.transferId)
  const references = [
    ...agentSessionAttachmentReferences(
      agentSessionAttachmentStoreRoot(stateDirectory),
      original.body
    )
  ].sort()
  if (
    conversationContextDigest(claims) !== binding.attachmentClaimsDigest ||
    conversationContextDigest([...new Set(claims.map((claim) => claim.uploadId))].sort()) !==
      conversationContextDigest(references)
  ) {
    throw new ConversationRefusal('missing-source')
  }
  return { intent, conversation, binding, proof, original }
}
