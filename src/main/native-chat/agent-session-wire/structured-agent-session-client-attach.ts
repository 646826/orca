import { attachStructuredAgentSession } from './structured-agent-session-attach-orchestration'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'

/** Capture negotiation before the attach joins its existing session queue. */
export function attachStructuredAgentSessionForClient(
  context: Parameters<typeof attachStructuredAgentSession>[0],
  caller: StructuredAgentSessionCaller,
  params: Parameters<typeof attachStructuredAgentSession>[2],
  options?: Parameters<typeof attachStructuredAgentSession>[3]
) {
  return attachStructuredAgentSession(context, caller.callerKey, params, {
    ...options,
    conversationMutationSupported: caller.conversationMutationSupported
  })
}
