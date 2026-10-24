import type { ConversationContextRepresentation } from '../../../shared/conversation-handoff'
import { conversationContextDigest } from './conversation-context-consent'

/** Coverage equivalence only. Manifest consent and sealed-index integrity still hash the entire part. */
export function conversationRepresentationCoverageDigest(
  part: ConversationContextRepresentation
): string {
  return conversationContextDigest(
    part.representation === 'exact' || part.representation === 'transport-projected'
      ? {
          version: part.version,
          representation: part.representation,
          text: part.text,
          ...(part.transportProjection ? { transportProjection: part.transportProjection } : {})
        }
      : part
  )
}
