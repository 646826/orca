import type { ConversationWorkspaceObservationStatus } from './conversation-workspace-observation'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import type {
  ConversationContextManifest,
  ConversationProjectionConsent
} from './conversation-handoff'
import type { ConversationSwitchIntent } from './conversation-record'

export type ConversationRecipientChoice = {
  operationKey: string
  expectedVersion: number
  expectedContextGeneration: number
  expectedApprovalRevision: number
  targetBindingDigest: string
  capabilityFingerprint: string
  policy: 'full' | 'budgeted' | 'fresh'
  disclosure: 'available-canonical'
}
export type ConversationManifestChoice = Omit<ConversationProjectionConsent, 'approvedBy'> & {
  operationKey: string
  expectedVersion: number
  expectedContextGeneration: number
}
export type ConversationPreparationView = {
  workspaceObservation?: ConversationWorkspaceObservationStatus
  operationKey: string
  conversationId: string
  operationVersion: number
  contextGeneration: number
  phase: ConversationSwitchIntent['phase']
  activeSessionId: string | null
  selectedSessionId: string
  approvalRevision: number
  target: {
    sessionId: string
    provider: string
    model: string
    accountBindingDigest: string
    capabilityFingerprint: string
    bindingDigest: string
    budget: 'unknown' | 'observed'
  } | null
  preview: null | {
    manifestDigest: string
    targetBindingDigest: string
    capabilityFingerprint: string
    transformationsDigest: string
    omissionsDigest: string
    policy: ConversationContextManifest['policy']
    completeness: ConversationContextManifest['completeness']
    sourceCount: number
    gapCount: number | null
    gapCountComplete: boolean
    inputEstimate: number | null
    estimateConfidence: 'unknown' | 'upper-bound' | 'exact'
    consented: boolean
  }
  status: 'target-unavailable' | 'recipient-choice' | 'preview' | 'stale'
}

export type ConversationHistoryCursor = {
  epochOrdinal: number
  sequence: number
  index: number
  ordinal: number
}
export type ConversationHistoricalPage = {
  sourceRevision: string
  segmentId: string
  readOnly: true
  items: {
    segmentId: string
    provider: string
    originSource: { sessionId: string; epoch: string; sequence: number }
    revisionEpoch: string
    item: AgentJournalRenderItem
  }[]
  next: ConversationHistoryCursor | null
  status: 'complete' | 'more' | 'resource-limit' | 'source-unavailable'
}

export type ConversationOperationView = Pick<
  ConversationSwitchIntent,
  | 'operationKey'
  | 'conversationId'
  | 'targetSessionId'
  | 'candidateSegmentId'
  | 'contextGeneration'
  | 'activationFence'
  | 'nativeBindingGeneration'
  | 'version'
  | 'phase'
> & { sourceBoundaryCount: number; candidateBoundaryCount: number }

export type ConversationPreparationEvidencePage = {
  manifestDigest: string
  sourceRevision: string
  targetBindingDigest: string
  transformationsDigest: string
  omissionsDigest: string
  manifestGaps: ConversationContextManifest['gaps']
  entries: {
    ordinal: number
    version: ConversationContextManifest['projection'][number]['version']
    representation: ConversationContextManifest['projection'][number]['representation']
    spans: ConversationContextManifest['projection'][number]['spans']
    gaps: ConversationContextManifest['gaps']
    transformedText?: string
  }[]
  next: number | null
  complete: boolean
}
