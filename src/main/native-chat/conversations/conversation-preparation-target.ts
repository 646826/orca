import { conversationTriggerBindingSchema } from './conversation-trigger-schema'
import type Database from '../../sqlite/sync-database'
import type { ConversationContextManifest } from '../../../shared/conversation-handoff'
import type { ConversationPreparationTarget } from './conversation-preparation-authority'
import { conversationContextDigest } from './conversation-context-consent'
import { conversationDeliveryPlanSchema } from './conversation-delivery-schema'

/** Only adapter-owned immutable prewrite evidence establishes that effects may have begun. */
function workspaceWasDelivered(
  db: Database.Database,
  manifest: ConversationContextManifest,
  expected: ConversationPreparationTarget,
  operationKey: string | undefined
): boolean {
  if (!operationKey) {
    return false
  }
  const row = db
    .prepare(`SELECT binding_json FROM conversation_trigger_reservations
    WHERE operation_key=? AND kind='trigger'`)
    .get(operationKey)
  if (!row) {
    return false
  }
  const binding = conversationTriggerBindingSchema.parse(JSON.parse(String(row.binding_json)))
  const native = db
    .prepare(`SELECT p.plan_json,i.submission_id FROM conversation_delivery_plans p
    JOIN conversation_delivery_inputs i ON i.plan_id=p.plan_id WHERE p.plan_id=?`)
    .get(binding.deliveryPlanId)
  if (!native) {
    return false
  }
  const plan = conversationDeliveryPlanSchema.parse(JSON.parse(String(native.plan_json)))
  return (
    binding.operationKey === operationKey &&
    plan.operationKey === operationKey &&
    native.submission_id === binding.targetSubmissionId &&
    binding.manifestId === manifest.manifestId &&
    binding.manifestDigest === manifest.digest &&
    plan.manifestId === manifest.manifestId &&
    plan.manifestDigest === manifest.digest &&
    plan.targetSessionId === manifest.target.sessionId &&
    plan.contextGeneration === manifest.contextGeneration &&
    plan.nativeBindingGeneration === expected.target.nativeBindingGeneration &&
    plan.nativeIdentityDigest === expected.nativeIdentityDigest &&
    plan.runtimeFence === expected.runtimeFence
  )
}
/** All native/source authority remains live; workspace events cannot identify their writer. */
export function assertConversationPreparationTarget(
  db: Database.Database,
  manifest: ConversationContextManifest,
  expected: ConversationPreparationTarget,
  current: ConversationPreparationTarget | null,
  now: number,
  allowDispatchedWorkspace: boolean,
  operationKey?: string
): void {
  if (!current) {
    throw new Error('Preparation target changed')
  }
  const { workspaceObservation: expectedWorkspace, ...expectedNative } = expected
  const { workspaceObservation: currentWorkspace, ...currentNative } = current
  if (
    conversationContextDigest(currentNative) !== conversationContextDigest(expectedNative) ||
    (conversationContextDigest(currentWorkspace ?? null) !==
      conversationContextDigest(expectedWorkspace ?? null) &&
      !(allowDispatchedWorkspace && workspaceWasDelivered(db, manifest, expected, operationKey))) ||
    conversationContextDigest(current.target) !== conversationContextDigest(manifest.target) ||
    conversationContextDigest(current.budget) !== conversationContextDigest(manifest.budget) ||
    (manifest.policy === 'fresh' && !current.freshNative) ||
    (current.budget && (current.budget.observedAt > now || current.budget.validUntil < now))
  ) {
    throw new Error('Preparation target changed')
  }
}
