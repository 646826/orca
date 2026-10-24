import { dispatchCodexTurn } from './codex-structured-turn-start'
import type { CodexStructuredSessionAdapterDeps } from './codex-structured-session-state'
import type { ConversationOriginCorrelation } from '../native-chat/conversations/conversation-origin-correlation'
import { codexTurnLifecycleIdentity } from './codex-structured-journal-translation-turns'
export function codexOriginCorrelation(
  input: { sessionId: string; clientMessageId: string },
  fence: number,
  emit: ((event: ConversationOriginCorrelation) => void) | undefined
): (turnId: string) => void {
  return (turnId) =>
    emit?.({
      state: 'origin-correlated',
      sessionId: input.sessionId,
      clientMessageId: input.clientMessageId,
      fence,
      turnIdentity: codexTurnLifecycleIdentity(input.sessionId, turnId)
    })
}

export function dispatchCodexTurnWithOrigin(
  session: Parameters<typeof dispatchCodexTurn>[0] & { fence: number },
  input: Parameters<typeof dispatchCodexTurn>[1],
  deps: Pick<CodexStructuredSessionAdapterDeps, 'onDispatchSettledLate' | 'requestTimeoutMs'>
) {
  return dispatchCodexTurn(
    session,
    {
      ...input,
      onTurnCorrelated: codexOriginCorrelation(input, session.fence, deps.onDispatchSettledLate)
    },
    deps.requestTimeoutMs
  )
}
