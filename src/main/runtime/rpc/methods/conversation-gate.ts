import { NATIVE_CONVERSATION_RUNTIME_CAPABILITY } from '../../../../shared/conversation-runtime-capabilities'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { RpcContext } from '../core'
import { requireStructuredSessionHost } from './structured-agent-session-gate'

export function requireConversationMutationCapability(
  context: RpcContext,
  host: StructuredAgentSessionHost,
  sessionId: string
): void {
  if (
    context.clientKind !== undefined &&
    !context.clientCapabilities?.includes(NATIVE_CONVERSATION_RUNTIME_CAPABILITY) &&
    host.deps.store.conversations.membership(sessionId)
  ) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
}

export function requireConversationMutationHost(context: RpcContext, sessionId: string) {
  const host = requireStructuredSessionHost(context, sessionId)
  // Receipt replay is allowed. New effects recheck the trusted caller in host admission.
  return host
}
