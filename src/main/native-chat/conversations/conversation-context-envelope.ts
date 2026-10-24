import type { ConversationContextManifest } from '../../../shared/conversation-handoff'
import { conversationRepresentationCoverageDigest } from './conversation-context-coverage-identity'

export function conversationContextEnvelope(
  manifest: Pick<ConversationContextManifest, 'projection' | 'mandatory' | 'evidenceIndex'>,
  inlineKeys?: readonly string[]
): string {
  const selected = inlineKeys && new Set(inlineKeys)
  return JSON.stringify({
    historicalEvidence: selected
      ? manifest.projection.filter(
          (part) =>
            selected.has(conversationRepresentationCoverageDigest(part)) ||
            part.representation === 'retrievable-only'
        )
      : manifest.projection,
    activeConstraints: manifest.mandatory,
    ...(manifest.evidenceIndex ? { evidenceIndex: manifest.evidenceIndex } : {})
  })
}
