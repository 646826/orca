import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { ConversationRefusal } from '../conversations/conversation-read-model'

/** Captured in the startup admission lane, then carried unchanged through all waits. */
export function captureConversationStartScope(
  store: Pick<AgentSessionRecordStore, 'conversations'>,
  sessionId: string,
  expectedOperationKey?: string | null
): string | null {
  const member = store.conversations.membership(sessionId)
  const current = member
    ? (store.conversations.read(member.conversationId)?.pendingOperationKey ?? null)
    : null
  if (expectedOperationKey !== undefined && current !== expectedOperationKey) {
    throw new ConversationRefusal('stale-generation')
  }
  return current
}
