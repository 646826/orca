import type { ConversationRefusalReason } from './conversation-wire'
export type ConversationRpcRefusalReason =
  | ConversationRefusalReason
  | 'source-unavailable'
  | 'target-unavailable'
  | 'stale-preview'
  | 'unsupported'
  | 'unauthenticated'
  | 'resource-limit'
  | 'trust-required'
  | 'native-rebuild-required'
/** Semantic protocol fact; the renderer supplies the localized headline. */
export class ConversationRpcRefusal extends Error {
  constructor(
    readonly reason: ConversationRpcRefusalReason,
    readonly errorText?: string
  ) {
    super('conversation_refused')
  }
}
