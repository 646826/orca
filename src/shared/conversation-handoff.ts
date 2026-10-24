import type { ConversationSourceRef } from './conversation-record'

export type ConversationEvidenceVersion = { source: ConversationSourceRef; sha256: string }
/** Byte offsets into the original serialized journal row, never decoded field text. */
export type ConversationEvidenceSpan = {
  version: ConversationEvidenceVersion
  startByte: number
  endByte: number
}
export type ConversationCoverageRepresentation =
  | 'exact'
  | 'transport-projected'
  | 'summarized'
  | 'retrievable-only'
  | 'missing'
export type ConversationEvidenceGap = {
  source: ConversationSourceRef
  reason:
    | 'captured-incomplete'
    | 'legacy-bounded'
    | 'missing-artifact'
    | 'changed-artifact'
    | 'corrupt-source'
    | 'newer-schema'
    | 'unsupported-format'
    | 'excluded'
  critical: boolean
}
export type ConversationContextOriginal = {
  version: ConversationEvidenceVersion
  /** Absent when original bytes are retained only in an authenticated artifact. */
  text?: string
  byteLength?: number
  artifactId?: string
  kind: 'user' | 'assistant' | 'tool' | 'historical-data'
  toolInteractionId?: string
  gaps: ConversationEvidenceGap[]
}
export type ConversationContextRepresentation = {
  version: ConversationEvidenceVersion
  representation: ConversationCoverageRepresentation
  text?: string
  artifactId?: string
  spans: ConversationEvidenceSpan[]
  transportProjection?: {
    transfers: { transferId: string; bodyPath: string; bindingDigest: string }[]
  }
}
export type ConversationInlineConstraint = {
  id: string
  text: string
  sources: ConversationEvidenceVersion[]
  supersedes: string[]
  decodedFields?: {
    version: ConversationEvidenceVersion
    jsonPointer: string
    decodedSha256: string
  }[]
}
export type ConversationContextTarget = {
  sessionId: string
  provider: string
  accountBindingDigest: string
  nativeBindingGeneration: number
  capabilityFingerprint: string
  model: string
  retrieval: 'verified' | 'unsupported'
}
export type ConversationContextBudget = {
  capacity: number | null
  occupied: number | null
  reserved: number
  confidence: 'exact' | 'upper-bound' | 'unknown'
  targetFingerprint: string
  nativeBindingGeneration: number
  model: string
  accountBindingDigest: string
  observedAt: number
  validUntil: number
}
export type ConversationContextInput = {
  evidenceIndex?: ConversationEvidenceIndex
  conversationId: string
  contextGeneration: number
  sourceRevision: string
  target: ConversationContextTarget
  policy: 'full' | 'budgeted' | 'fresh'
  originals: ConversationContextOriginal[]
  gaps?: ConversationEvidenceGap[]
  projection: ConversationContextRepresentation[]
  mandatory: ConversationInlineConstraint[]
  budget: ConversationContextBudget | null
  countTokens: ((text: string) => number) | null
  inputTokenConfidence?: 'exact' | 'upper-bound' | 'unknown'
  /** Host-only verifier; a persisted proof is independently rechecked at durable admission. */
  verifyTransportProjection?: (
    original: ConversationContextOriginal,
    part: ConversationContextRepresentation
  ) => boolean
  signal: AbortSignal
  now: number
}
export type ConversationContextManifest = {
  evidenceIndex?: ConversationEvidenceIndex
  manifestId: string
  digest: string
  conversationId: string
  contextGeneration: number
  sourceRevision: string
  target: ConversationContextTarget
  policy: ConversationContextInput['policy']
  projection: ConversationContextRepresentation[]
  mandatory: ConversationInlineConstraint[]
  gaps: ConversationEvidenceGap[]
  completeness:
    | 'available-canonical'
    | 'available-canonical-with-gaps'
    | 'budgeted-projection'
    | 'fresh'
  budget: ConversationContextBudget | null
  inputTokens: number | null
  inputTokenConfidence?: 'exact' | 'upper-bound' | 'unknown'
  targetBindingDigest: string
  transformationsDigest: string
  omissionsDigest: string
}
export type ConversationEvidenceIndex = {
  indexId: string
  partCount: number
  rootDigest: string
}
export type ConversationProjectionConsent = {
  manifestDigest: string
  targetBindingDigest: string
  capabilityFingerprint: string
  transformationsDigest: string
  omissionsDigest: string
  approvedBy: string
}
export type ConversationContextRefusal = {
  kind: 'refused'
  reason:
    | 'unknown-budget'
    | 'newer-schema'
    | 'overflow'
    | 'mandatory-not-inline'
    | 'critical-gap'
    | 'invalid-provenance'
    | 'missing-representation'
    | 'unsupported-representation'
    | 'resource-limit'
    | 'cancelled'
    | 'invalid-input'
}
export type ConversationContextResult =
  | { kind: 'compiled'; manifest: ConversationContextManifest }
  | ConversationContextRefusal
export type ConversationCoverageEntry = {
  manifestId: string
  receiptId: string
  targetSessionId: string
  targetBindingDigest: string
  contextGeneration: number
  nativeBindingGeneration: number
  version: ConversationEvidenceVersion
  representation: ConversationCoverageRepresentation
  representationDigest: string
}
