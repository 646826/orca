import type Database from '../../sqlite/sync-database'
import type { ConversationDeliveryHost } from './conversation-delivery-plan'
import {
  readConversationDeliveryBinding,
  assertConversationReservedDelivery
} from './conversation-delivery-binding'
import { readConversation, readParticipant } from './conversation-read-model'
import { readConversationTrigger } from './conversation-trigger-reservation'
import { assertConversationContinuationReceipt } from './conversation-continuation-authority'
import {
  assertConversationManifestAuthority,
  verifyConversationContextEvidence
} from './conversation-context-authority'
import { ConversationExportError } from './conversation-export-error'

export type ConversationEvidenceHost = ConversationDeliveryHost & {
  /** Captured by the native owner, never supplied by a tool invocation or RPC. */
  readAcquisition(sessionId: string): {
    acquisitionGeneration: string
    capabilityFingerprint: string
  } | null
}
/** Invocation authority, distinct from tool registration readiness during preparation. */
export function assertConversationEvidenceScope(
  db: Database.Database,
  planId: string,
  host: ConversationEvidenceHost,
  acquisitionGeneration: string
) {
  const bound = readConversationDeliveryBinding(db, planId, host)
  const { plan, manifest, intent } = bound
  const conversation = readConversation(db, manifest.conversationId)
  const target = readParticipant(db, plan.targetSessionId)
  const acquisition = host.readAcquisition(plan.targetSessionId)
  const trigger = readConversationTrigger(db, plan.operationKey)
  if (
    !conversation ||
    !target ||
    !acquisition ||
    !trigger ||
    acquisition.acquisitionGeneration !== acquisitionGeneration ||
    acquisition.capabilityFingerprint !== manifest.target.capabilityFingerprint ||
    conversation.contextGeneration !== manifest.contextGeneration ||
    target.conversationId !== manifest.conversationId ||
    target.contextGeneration !== manifest.contextGeneration ||
    target.nativeBindingGeneration !== plan.nativeBindingGeneration ||
    trigger.binding.deliveryPlanId !== planId ||
    trigger.binding.manifestDigest !== manifest.digest
  ) {
    throw new ConversationExportError('scope')
  }
  if (intent.phase === 'activated' && conversation.activeSegmentId === intent.candidateSegmentId) {
    assertConversationContinuationReceipt(db, trigger.binding, intent)
    return { ...bound, mode: 'active' as const }
  }
  if (intent.phase !== 'delivering' || conversation.pendingOperationKey !== intent.operationKey) {
    throw new ConversationExportError('scope')
  }
  const input = db
    .prepare(
      'SELECT submission_id,payload_fingerprint FROM conversation_delivery_inputs WHERE plan_id=?'
    )
    .get(planId)
  if (
    !input ||
    input.submission_id !== trigger.binding.targetSubmissionId ||
    input.payload_fingerprint !== trigger.binding.targetFingerprint
  ) {
    throw new ConversationExportError('scope')
  }
  assertConversationReservedDelivery(db, planId, trigger.binding.targetSubmissionId, host)
  verifyConversationContextEvidence(db, manifest, host.readPreparationEvidence)
  // Per-request source membership is checked separately; do not materialize the full index here.
  assertConversationManifestAuthority(db, { ...manifest, projection: [] })
  return { ...bound, mode: 'candidate' as const }
}
