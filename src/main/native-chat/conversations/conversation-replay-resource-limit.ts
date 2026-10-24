import type { ConversationSourceRef } from '../../../shared/conversation-record'

/** Replay memory admission, not a model budget; larger originals use verified streaming export. */
export const MAX_CONVERSATION_REPLAY_ROW_BYTES = 128 * 1024
export const DEFAULT_CONVERSATION_PAGE_BYTES = 1024 * 1024
export function assertConversationPageBytes(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 4 * 1024 * 1024) {
    throw new RangeError('Replay page byte budget must be between 1 and 4194304')
  }
}
export class ConversationReplayResourceLimit extends Error {
  readonly reason = 'resource-limit'
  constructor(
    readonly byteLength: number,
    readonly source?: ConversationSourceRef
  ) {
    super('Canonical evidence exceeds the requested replay page byte budget')
  }
}
