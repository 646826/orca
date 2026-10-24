import { isConversationSourceBoundary } from './conversation-record'
import type { AgentSessionExecutionLocation, AgentSessionAccountHome } from './agent-session-record'
import type { ConversationSourceBoundary, ConversationSwitchIntent } from './conversation-record'

export type ConversationTargetIdentity = {
  sessionId: string
  provider: string
  location: AgentSessionExecutionLocation
  accountHome: AgentSessionAccountHome
}
export type ConversationSwitchRequest = {
  conversationId: string
  expectedRevision: number
  expectedContextGeneration: number
  expectedActivationFence: number
  target: ConversationTargetIdentity
  expectedNativeBindingGeneration: number
}
export type ConversationSwitchProgress = {
  operationKey: string
  expectedVersion: number
  candidateBoundary?: ConversationSourceBoundary
  phase: ConversationSwitchIntent['phase']
  sourceBoundaries: ConversationSourceBoundary[]
  manifestId: string | null
  deliveryReceiptId: string | null
}
export type ConversationCancellationRequest = {
  operationKey: string
  expectedVersion: number
  expectedRevision: number
  expectedContextGeneration: number
  expectedActivationFence: number
}
export type ConversationActivationRequest = {
  operationKey: string
  expectedVersion: number
  expectedRevision: number
  expectedContextGeneration: number
  expectedActivationFence: number
  expectedNativeBindingGeneration: number
  deliveryReceiptId: string
  sourceBoundaries: ConversationSourceBoundary[]
}
export type ConversationRefusalReason =
  | 'missing-record'
  | 'identity-mismatch'
  | 'scope-mismatch'
  | 'already-bound'
  | 'stale-generation'
  | 'stale-source'
  | 'busy'
  | 'missing-source'
  | 'invalid-phase'
  | 'corrupt-record'
  | 'unverified-delivery'
  | 'expired-intent'

export type ConversationDeliveryEvidence = {
  deliveryReceiptId: string
  operationKey: string
  manifestId: string
  targetSessionId: string
  contextGeneration: number
  activationFence: number
  nativeBindingGeneration: number
  sourceBoundaries: ConversationSourceBoundary[]
  candidateBoundary: ConversationSourceBoundary
  candidateBaseline: ConversationSourceBoundary[]
  candidateReadback: ConversationSourceBoundary[]
}
export type ConversationSessionRoute =
  | { role: 'unbound' }
  | {
      role: 'active' | 'candidate' | 'parked'
      conversationId: string
      contextGeneration: number
      activationFence: number
      nativeBindingGeneration: number
      mutation: 'none' | 'switch' | 'clear'
      switching: boolean
    }

export function isConversationDeliveryEvidence(
  value: unknown
): value is ConversationDeliveryEvidence {
  return (
    typeof value === 'object' &&
    value !== null &&
    'deliveryReceiptId' in value &&
    typeof value.deliveryReceiptId === 'string' &&
    'operationKey' in value &&
    typeof value.operationKey === 'string' &&
    'manifestId' in value &&
    typeof value.manifestId === 'string' &&
    'targetSessionId' in value &&
    typeof value.targetSessionId === 'string' &&
    'contextGeneration' in value &&
    typeof value.contextGeneration === 'number' &&
    Number.isSafeInteger(value.contextGeneration) &&
    'activationFence' in value &&
    typeof value.activationFence === 'number' &&
    Number.isSafeInteger(value.activationFence) &&
    'nativeBindingGeneration' in value &&
    typeof value.nativeBindingGeneration === 'number' &&
    Number.isSafeInteger(value.nativeBindingGeneration) &&
    'sourceBoundaries' in value &&
    Array.isArray(value.sourceBoundaries) &&
    value.sourceBoundaries.every(isConversationSourceBoundary) &&
    'candidateBaseline' in value &&
    Array.isArray(value.candidateBaseline) &&
    value.candidateBaseline.every(isConversationSourceBoundary) &&
    'candidateReadback' in value &&
    Array.isArray(value.candidateReadback) &&
    value.candidateReadback.every(isConversationSourceBoundary) &&
    'candidateBoundary' in value &&
    isConversationSourceBoundary(value.candidateBoundary)
  )
}
