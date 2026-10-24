import type Database from '../../sqlite/sync-database'
import type { ConversationSwitchIntent } from '../../../shared/conversation-record'
import type {
  ConversationSwitchPreparation,
  ConversationSwitchPlan
} from '../conversations/conversation-switch-contracts'
import type { ConversationDeliveryHost } from '../conversations/conversation-delivery-plan'

export type ConversationPreparationTrigger = {
  queueSessionId: string
  messageId: string
  transferId: string
  targetOptionsDigest: string
  sourceFingerprint: string
  attachmentClaimsDigest: string
}
export type ConversationSwitchPreparationService = {
  prepare(
    intent: ConversationSwitchIntent,
    previousManifestId: string | null,
    signal: AbortSignal,
    trigger: ConversationPreparationTrigger | null
  ): Promise<ConversationSwitchPreparation>
  readPlan(manifestId: string): ConversationSwitchPlan | null
  verifyTrigger(manifestId: string, trigger: ConversationPreparationTrigger): void
}
export type StructuredConversationSwitchRuntimePorts = {
  db: Database.Database
  stateDirectory: string
  deliveryHost: ConversationDeliveryHost
  preparation: ConversationSwitchPreparationService
  ensureCandidate(intent: ConversationSwitchIntent, signal: AbortSignal): Promise<void>
  flushEvents(sessionId: string): Promise<void>
  wakeDelivery(sessionId: string, signal: AbortSignal): Promise<void>
  publishSourceQueue(sessionId: string): void
  reportContinuationFailure(operationKey: string, error: unknown): void
  now(): number
}
