import {
  isAgentSessionExecutionLocation,
  type AgentSessionExecutionLocation
} from './agent-session-record'
import {
  isAgentSessionAccountHome,
  type AgentSessionAccountHome
} from './agent-session-account-home'

export type ConversationSourceBoundary = { sessionId: string; epoch: string; endSequence: number }
export type ConversationSourceRef = {
  sessionId: string
  epoch: string
  sequence: number
  itemId?: string
  itemRevision?: number
  batchIndex?: number
}
export type ConversationRecord = {
  conversationId: string
  location: AgentSessionExecutionLocation
  revision: number
  contextGeneration: number
  activationFence: number
  activeSegmentId: string
  pendingOperationKey: string | null
}
export type ConversationParticipant = {
  conversationId: string
  sessionId: string
  provider: string
  location: AgentSessionExecutionLocation
  accountHome: AgentSessionAccountHome
  nativeBindingGeneration: number
  contextGeneration: number
  state: 'active' | 'parked'
}
export type ConversationSegment = {
  /** Absent only on legacy activated segments. */
  lifecycle?: 'candidate' | 'activated'
  segmentId: string
  conversationId: string
  ordinal: number
  sessionId: string
  contextGeneration: number
  activationFence: number
  nativeBindingGeneration: number
  startSequence: number
  boundary: ConversationSourceBoundary
}
export type ConversationSwitchIntent = {
  /** Null legacy intents require explicit recovery before new effects. */
  candidateSegmentId: string | null
  operationKey: string
  conversationId: string
  targetSessionId: string
  contextGeneration: number
  activationFence: number
  nativeBindingGeneration: number
  version: number
  phase:
    | 'quiescing'
    | 'prepared'
    | 'delivering'
    | 'reconciliation-required'
    | 'activated'
    | 'cancelled'
  sourceBoundaries: ConversationSourceBoundary[]
  candidateBaseline: ConversationSourceBoundary[]
  candidateBoundary: ConversationSourceBoundary
  manifestId: string | null
  deliveryReceiptId: string | null
}
export type ConversationActivationResult = {
  conversationId: string
  segmentId: string
  contextGeneration: number
  activationFence: number
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
export function isConversationSourceBoundary(value: unknown): value is ConversationSourceBoundary {
  return object(value) && text(value.sessionId) && text(value.epoch) && positive(value.endSequence)
}
export function isConversationRecord(value: unknown): value is ConversationRecord {
  return (
    object(value) &&
    text(value.conversationId) &&
    isAgentSessionExecutionLocation(value.location) &&
    positive(value.revision) &&
    positive(value.contextGeneration) &&
    positive(value.activationFence) &&
    text(value.activeSegmentId) &&
    (value.pendingOperationKey === null || text(value.pendingOperationKey))
  )
}
export function isConversationParticipant(value: unknown): value is ConversationParticipant {
  return (
    object(value) &&
    text(value.conversationId) &&
    text(value.sessionId) &&
    text(value.provider) &&
    isAgentSessionExecutionLocation(value.location) &&
    isAgentSessionAccountHome(value.accountHome) &&
    positive(value.nativeBindingGeneration) &&
    positive(value.contextGeneration) &&
    (value.state === 'active' || value.state === 'parked')
  )
}
export function isConversationSegment(value: unknown): value is ConversationSegment {
  return (
    object(value) &&
    text(value.segmentId) &&
    text(value.conversationId) &&
    text(value.sessionId) &&
    positive(value.ordinal) &&
    (value.lifecycle === undefined ||
      value.lifecycle === 'candidate' ||
      value.lifecycle === 'activated') &&
    positive(value.contextGeneration) &&
    positive(value.activationFence) &&
    positive(value.nativeBindingGeneration) &&
    positive(value.startSequence) &&
    isConversationSourceBoundary(value.boundary) &&
    value.boundary.sessionId === value.sessionId
  )
}
export function isConversationSwitchIntent(value: unknown): value is ConversationSwitchIntent {
  return (
    object(value) &&
    text(value.operationKey) &&
    (value.candidateSegmentId === null || text(value.candidateSegmentId)) &&
    text(value.conversationId) &&
    text(value.targetSessionId) &&
    positive(value.contextGeneration) &&
    positive(value.activationFence) &&
    positive(value.nativeBindingGeneration) &&
    positive(value.version) &&
    (value.phase === 'quiescing' ||
      value.phase === 'prepared' ||
      value.phase === 'delivering' ||
      value.phase === 'reconciliation-required' ||
      value.phase === 'activated' ||
      value.phase === 'cancelled') &&
    Array.isArray(value.sourceBoundaries) &&
    value.sourceBoundaries.every(isConversationSourceBoundary) &&
    isConversationSourceBoundary(value.candidateBoundary) &&
    Array.isArray(value.candidateBaseline) &&
    value.candidateBaseline.every(isConversationSourceBoundary) &&
    (value.manifestId === null || text(value.manifestId)) &&
    (value.deliveryReceiptId === null || text(value.deliveryReceiptId))
  )
}
export function isConversationActivationResult(
  value: unknown
): value is ConversationActivationResult {
  return (
    object(value) &&
    text(value.conversationId) &&
    text(value.segmentId) &&
    positive(value.contextGeneration) &&
    positive(value.activationFence)
  )
}

export type ConversationSourceSpan = ConversationSourceBoundary & {
  segmentId: string
  ordinal: number
  startSequence: number
}
