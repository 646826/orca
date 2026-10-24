import type Database from '../../sqlite/sync-database'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionLeaseAdmitsWriter } from '../../../shared/agent-session-lease-adjudication'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import { conversationContextAccountDigest } from './conversation-context-authority'
import { conversationContextDigest } from './conversation-context-consent'
import { readConversationDeliveryPlan } from './conversation-delivery-plan'
import { readConversationNativeRecord } from './conversation-origin-native-identity'
import { readParticipant } from './conversation-read-model'
import type { ConversationTriggerBinding } from './conversation-trigger-schema'
import {
  MAX_PROOF_BYTES,
  MAX_ROW_BYTES,
  type HandoverScope
} from './conversation-transfer-no-write-schema'

function immutableIdentity(record: AgentSessionRecord) {
  const handle = agentSessionProviderHandleChainHead(record.providerHandleChain)?.handle
  return handle
    ? {
        recordBirthDigest: conversationContextDigest({
          sessionId: record.sessionId,
          createdAt: record.createdAt,
          provider: record.provider,
          location: record.location,
          accountHome: record.accountHome
        }),
        accountBindingDigest: conversationContextAccountDigest(record),
        nativeHandleDigest: conversationContextDigest({
          transport: handle.transport,
          agent: handle.agent,
          nativeId: handle.nativeId
        })
      }
    : null
}

/** Identity only: this never establishes current runtime ownership or permission to act. */
export function matchesConversationTransferNoWriteIdentity(
  record: AgentSessionRecord,
  scope: HandoverScope
): boolean {
  const identity = immutableIdentity(record)
  return (
    record.sessionId === scope.targetSessionId &&
    identity !== null &&
    identity.recordBirthDigest === scope.recordBirthDigest &&
    identity.accountBindingDigest === scope.accountBindingDigest &&
    identity.nativeHandleDigest === scope.nativeHandleDigest
  )
}

export function matchesConversationTransferNoWriteSourceIdentity(
  record: AgentSessionRecord,
  scope: HandoverScope
): boolean {
  const identity = immutableIdentity(record)
  return (
    record.sessionId === scope.sourceSessionId &&
    identity !== null &&
    identity.recordBirthDigest === scope.sourceRecordBirthDigest &&
    identity.accountBindingDigest === scope.sourceAccountBindingDigest &&
    identity.nativeHandleDigest === scope.sourceNativeHandleDigest
  )
}

export function sourceNativeScope(db: Database.Database, binding: ConversationTriggerBinding) {
  const bytes = db
    .prepare('SELECT octet_length(record_json) bytes FROM agent_session_records WHERE session_id=?')
    .get(binding.queueSessionId)?.bytes
  const participantBytes = db
    .prepare(
      'SELECT octet_length(record_json) bytes FROM conversation_participants WHERE session_id=?'
    )
    .get(binding.queueSessionId)?.bytes
  if (
    typeof bytes !== 'number' ||
    bytes > MAX_ROW_BYTES ||
    typeof participantBytes !== 'number' ||
    participantBytes > MAX_PROOF_BYTES
  ) {
    return null
  }
  const record = readConversationNativeRecord(db, binding.queueSessionId)
  const participant = readParticipant(db, binding.queueSessionId)
  const identity = record && immutableIdentity(record)
  return identity &&
    participant?.conversationId === binding.conversationId &&
    participant.contextGeneration === binding.contextGeneration
    ? {
        sourceNativeBindingGeneration: participant.nativeBindingGeneration,
        sourceRecordBirthDigest: identity.recordBirthDigest,
        sourceAccountBindingDigest: identity.accountBindingDigest,
        sourceNativeHandleDigest: identity.nativeHandleDigest
      }
    : null
}

function nativeEvidence(db: Database.Database, binding: ConversationTriggerBinding, fence: number) {
  const recordBytes = db
    .prepare('SELECT octet_length(record_json) bytes FROM agent_session_records WHERE session_id=?')
    .get(binding.targetSessionId)?.bytes
  const planBytes = db
    .prepare(
      'SELECT octet_length(plan_json) bytes FROM conversation_delivery_plans WHERE plan_id=?'
    )
    .get(binding.deliveryPlanId)?.bytes
  if (
    typeof recordBytes !== 'number' ||
    recordBytes > MAX_ROW_BYTES ||
    typeof planBytes !== 'number' ||
    planBytes > MAX_PROOF_BYTES
  ) {
    return null
  }
  const record = readConversationNativeRecord(db, binding.targetSessionId)
  const head = record && agentSessionProviderHandleChainHead(record.providerHandleChain)
  const plan = readConversationDeliveryPlan(db, binding.deliveryPlanId)
  if (
    !record ||
    !head ||
    !plan ||
    plan.runtimeFence !== fence ||
    plan.operationKey !== binding.operationKey ||
    plan.targetSessionId !== binding.targetSessionId ||
    plan.manifestId !== binding.manifestId ||
    plan.manifestDigest !== binding.manifestDigest ||
    plan.contextGeneration !== binding.contextGeneration ||
    plan.nativeBindingGeneration !== binding.nativeBindingGeneration
  ) {
    return null
  }
  return { record, head, plan }
}

export function nativeScope(
  db: Database.Database,
  binding: ConversationTriggerBinding,
  fence: number
) {
  const evidence = nativeEvidence(db, binding, fence)
  if (!evidence) {
    return null
  }
  const { record, head, plan } = evidence
  const identity = immutableIdentity(record)
  const nativeIdentityDigest = conversationContextDigest({
    head,
    account: conversationContextAccountDigest(record)
  })
  return identity &&
    agentSessionLeaseAdmitsWriter(record.lease) &&
    record.lease.provenHandleLinkId === head.linkId &&
    record.lease.runtimeFence === fence &&
    nativeIdentityDigest === plan.nativeIdentityDigest
    ? { ...identity, nativeIdentityDigest }
    : null
}

/** The original fence binds the old attempt, not the newly acquired host owner. */
export function historicalNativeScope(
  db: Database.Database,
  binding: ConversationTriggerBinding,
  scope: HandoverScope
): boolean {
  const evidence = nativeEvidence(db, binding, scope.runtimeFence)
  return (
    evidence !== null &&
    evidence.plan.nativeIdentityDigest === scope.nativeIdentityDigest &&
    matchesConversationTransferNoWriteIdentity(evidence.record, scope)
  )
}
