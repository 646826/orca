import { conversationContextDigest } from './conversation-context-consent'
import { validateConversationContextEvidence } from './conversation-context-evidence'
import { conversationContextEnvelope } from './conversation-context-envelope'
import type {
  ConversationContextInput,
  ConversationContextResult
} from '../../../shared/conversation-handoff'
export {
  conversationEvidenceKey,
  validateConversationContextEvidence
} from './conversation-context-evidence'

export function compileConversationContext(
  input: ConversationContextInput
): ConversationContextResult {
  const refusal = validateConversationContextEvidence(input)
  if (refusal) {
    return refusal
  }
  const gaps = [...(input.gaps ?? []), ...input.originals.flatMap((source) => source.gaps)]
  const budget = input.budget
  if (
    input.policy === 'full' &&
    (!budget ||
      budget.capacity === null ||
      budget.occupied === null ||
      budget.confidence === 'unknown' ||
      (input.inputTokenConfidence !== 'exact' && input.inputTokenConfidence !== 'upper-bound'))
  ) {
    return { kind: 'refused', reason: 'unknown-budget' }
  }
  if (
    budget &&
    (budget.targetFingerprint !== input.target.capabilityFingerprint ||
      budget.nativeBindingGeneration !== input.target.nativeBindingGeneration ||
      budget.model !== input.target.model ||
      budget.accountBindingDigest !== input.target.accountBindingDigest ||
      !Number.isSafeInteger(input.now) ||
      !Number.isSafeInteger(budget.observedAt) ||
      !Number.isSafeInteger(budget.validUntil) ||
      budget.observedAt > input.now ||
      budget.validUntil < input.now)
  ) {
    return { kind: 'refused', reason: 'unknown-budget' }
  }
  const inputTokens = input.countTokens?.(conversationContextEnvelope(input)) ?? null
  if (
    (input.policy === 'full' && inputTokens === null) ||
    (inputTokens !== null && (!Number.isSafeInteger(inputTokens) || inputTokens < 0))
  ) {
    return { kind: 'refused', reason: 'unknown-budget' }
  }
  if (budget) {
    if (
      !Number.isSafeInteger(budget.reserved) ||
      budget.reserved < 0 ||
      ![budget.capacity, budget.occupied].every(
        (n) => n === null || (Number.isSafeInteger(n) && n >= 0)
      )
    ) {
      return { kind: 'refused', reason: 'unknown-budget' }
    }
    if (
      budget.capacity !== null &&
      budget.occupied !== null &&
      inputTokens !== null &&
      inputTokens + budget.occupied + budget.reserved > budget.capacity
    ) {
      return { kind: 'refused', reason: 'overflow' }
    }
  }
  const body = {
    ...(input.evidenceIndex ? { evidenceIndex: input.evidenceIndex } : {}),
    conversationId: input.conversationId,
    contextGeneration: input.contextGeneration,
    sourceRevision: input.sourceRevision,
    target: input.target,
    policy: input.policy,
    projection: input.projection,
    mandatory: input.mandatory,
    gaps,
    completeness:
      input.policy === 'fresh'
        ? ('fresh' as const)
        : input.policy === 'budgeted'
          ? ('budgeted-projection' as const)
          : gaps.length > 0
            ? ('available-canonical-with-gaps' as const)
            : ('available-canonical' as const),
    budget,
    inputTokens,
    inputTokenConfidence:
      inputTokens === null ? 'unknown' : (input.inputTokenConfidence ?? 'unknown'),
    targetBindingDigest: conversationContextDigest(input.target),
    transformationsDigest: conversationContextDigest({
      inline: input.projection.filter(
        (part) =>
          part.representation === 'summarized' || part.representation === 'transport-projected'
      ),
      ...(input.evidenceIndex ? { evidenceIndex: input.evidenceIndex } : {})
    }),
    omissionsDigest: conversationContextDigest({
      gaps,
      ...(input.evidenceIndex ? { evidenceIndex: input.evidenceIndex } : {}),
      omitted: input.projection.filter(
        (part) => part.representation === 'missing' || part.representation === 'retrievable-only'
      )
    })
  }
  const digest = conversationContextDigest(body)
  return { kind: 'compiled', manifest: structuredClone({ manifestId: digest, digest, ...body }) }
}
