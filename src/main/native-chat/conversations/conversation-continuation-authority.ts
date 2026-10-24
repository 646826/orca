import type Database from '../../sqlite/sync-database'
import { isConversationDeliveryEvidence } from '../../../shared/conversation-wire'
import type { ConversationSwitchIntent } from '../../../shared/conversation-record'
import type { ConversationTriggerBinding } from './conversation-trigger-schema'

/** Historical acceptance supports the committed generation, not renewed context delivery. */
export function assertConversationContinuationReceipt(
  db: Database.Database,
  binding: ConversationTriggerBinding,
  intent: ConversationSwitchIntent
): void {
  const row = db
    .prepare(`SELECT r.evidence_json,p.operation_key,p.manifest_id
    FROM conversation_delivery_receipts r JOIN conversation_delivery_plans p ON p.plan_id=r.plan_id
    WHERE r.receipt_id=? AND r.plan_id=?`)
    .get(intent.deliveryReceiptId, binding.deliveryPlanId)
  if (!row || typeof row.evidence_json !== 'string') {
    throw new Error('Committed delivery receipt unavailable')
  }
  const evidence: unknown = JSON.parse(row.evidence_json)
  if (
    row.operation_key !== binding.operationKey ||
    row.manifest_id !== binding.manifestId ||
    !isConversationDeliveryEvidence(evidence) ||
    evidence.deliveryReceiptId !== intent.deliveryReceiptId ||
    evidence.operationKey !== binding.operationKey ||
    evidence.manifestId !== binding.manifestId ||
    evidence.targetSessionId !== binding.targetSessionId ||
    evidence.contextGeneration !== binding.contextGeneration ||
    evidence.activationFence !== binding.candidateGeneration ||
    evidence.nativeBindingGeneration !== binding.nativeBindingGeneration
  ) {
    throw new Error('Committed delivery receipt identity changed')
  }
}
