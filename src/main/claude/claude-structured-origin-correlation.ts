import type { ConversationOriginCorrelation } from '../native-chat/conversations/conversation-origin-correlation'
import { claudeTurnLifecycleIdentity } from './claude-turn-lifecycle-item'
export function emitClaudeOriginCorrelation(
  sessionId: string,
  session: { fence: number; providerSessionId: string } | null | undefined,
  origin: { originCorrelation?: 'exact'; clientMessageId: string | null } | null,
  message: { type?: unknown; uuid?: unknown; parent_tool_use_id?: unknown },
  deps: { onDispatchSettledLate?: (event: ConversationOriginCorrelation) => void }
): void {
  if (
    origin?.originCorrelation !== 'exact' ||
    !origin.clientMessageId ||
    !session ||
    message.type !== 'user' ||
    typeof message.uuid !== 'string' ||
    message.parent_tool_use_id !== null
  ) {
    return
  }
  deps.onDispatchSettledLate?.({
    state: 'origin-correlated',
    sessionId,
    clientMessageId: origin.clientMessageId,
    fence: session.fence,
    turnIdentity: claudeTurnLifecycleIdentity(session.providerSessionId, message.uuid)
  })
}
