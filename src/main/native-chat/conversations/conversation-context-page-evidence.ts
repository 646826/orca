import { canonicalSourceRequiresInline } from './conversation-context-constraints'
import type {
  ConversationContextInput,
  ConversationContextOriginal,
  ConversationContextRepresentation,
  ConversationContextRefusal,
  ConversationEvidenceVersion
} from '../../../shared/conversation-handoff'
import {
  conversationEvidenceKey,
  validateConversationContextEvidence
} from './conversation-context-policy'

export type ConversationPageEvidenceResolvers = {
  /** Host-derived current user approval/required-state decision; never accepted from an RPC payload. */
  resolveRequirement?: (version: ConversationEvidenceVersion) => Promise<{
    version: ConversationEvidenceVersion
    contextGeneration: number
    sourceRevision: string
    requirement: 'mandatory-inline' | 'projection-approved'
  } | null>
  /** Original canonical source lookup, not a previous summary. The host must honor maxBytes. */
  resolveOriginal?: (
    version: ConversationEvidenceVersion,
    maxBytes: number
  ) => Promise<ConversationContextOriginal | null>
}
export async function validateConversationPageEvidence(
  input: ConversationContextInput &
    ConversationPageEvidenceResolvers & {
      original: ConversationContextOriginal
      representation: ConversationContextRepresentation
      maxReferenceBytes: number
    }
): Promise<
  | {
      kind: 'validated'
      originals: ConversationContextOriginal[]
      projection: ConversationContextRepresentation[]
    }
  | ConversationContextRefusal
> {
  const { original, representation } = input
  if (
    (original.text === undefined ||
      original.kind === 'user' ||
      canonicalSourceRequiresInline(original.text)) &&
    representation.representation !== 'exact' &&
    !(
      representation.representation === 'transport-projected' &&
      input.verifyTransportProjection?.(original, representation) === true
    )
  ) {
    const decision = await input.resolveRequirement?.(original.version)
    if (
      !decision ||
      decision.requirement !== 'projection-approved' ||
      decision.contextGeneration !== input.contextGeneration ||
      decision.sourceRevision !== input.sourceRevision ||
      conversationEvidenceKey(decision.version) !== conversationEvidenceKey(original.version)
    ) {
      return { kind: 'refused', reason: 'mandatory-not-inline' }
    }
  }
  const originals = [original],
    projection = [representation]
  const seen = new Set([conversationEvidenceKey(original.version)])
  let bytes = 0
  for (const span of representation.spans) {
    const key = conversationEvidenceKey(span.version)
    if (seen.has(key)) {
      continue
    }
    if (seen.size >= 32) {
      return { kind: 'refused', reason: 'resource-limit' }
    }
    const cited = await input.resolveOriginal?.(span.version, input.maxReferenceBytes - bytes)
    if (!cited || conversationEvidenceKey(cited.version) !== key || !cited.artifactId) {
      return { kind: 'refused', reason: 'invalid-provenance' }
    }
    bytes += Buffer.byteLength(JSON.stringify(cited))
    if (bytes > input.maxReferenceBytes) {
      return { kind: 'refused', reason: 'resource-limit' }
    }
    originals.push(cited)
    projection.push({
      version: cited.version,
      representation: 'retrievable-only',
      artifactId: cited.artifactId,
      spans: []
    })
    seen.add(key)
  }
  const refusal = validateConversationContextEvidence({
    ...input,
    evidenceIndex: undefined,
    originals,
    projection,
    mandatory: [],
    gaps: []
  })
  return refusal ?? { kind: 'validated', originals, projection }
}
