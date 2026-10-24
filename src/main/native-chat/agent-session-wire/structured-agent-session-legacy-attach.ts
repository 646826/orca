import { refuse } from '../../../shared/agent-session-wire-refusals'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'

export function legacyAttachRefusal(
  context: Pick<StructuredAgentSessionAttachContext, 'deps'>,
  sessionId: string,
  caller: Pick<StructuredAgentSessionCaller, 'conversationMutationSupported'>
) {
  return caller.conversationMutationSupported === false &&
    context.deps.store.conversations.membership(sessionId)
    ? refuse(
        'structured_agent_session_unsupported',
        { reason: 'clientCapabilityMissing' },
        'This client cannot attach a multi-agent conversation.'
      )
    : null
}
