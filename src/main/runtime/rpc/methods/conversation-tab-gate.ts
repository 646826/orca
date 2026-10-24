import { NATIVE_CONVERSATION_RUNTIME_CAPABILITY } from '../../../../shared/conversation-runtime-capabilities'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { RpcContext } from '../core'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'

export async function requireConversationTabMutationCapability(
  context: Pick<RpcContext, 'runtime' | 'clientKind' | 'clientCapabilities'>,
  snapshot: RuntimeMobileSessionTabsResult,
  tabId: string
): Promise<void> {
  if (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(NATIVE_CONVERSATION_RUNTIME_CAPABILITY)
  ) {
    return
  }
  const tab = snapshot.tabs.find((candidate) => candidate.id === tabId)
  if (tab?.type !== 'agent-session') {
    return
  }
  const store =
    getStructuredAgentSessionHost()?.deps.store ??
    (await context.runtime.openAgentSessionRecordStore())
  if (store.conversations.membership(tab.sessionId)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
}

/** Carries only host-owned negotiation and store authority across runtime awaits. */
export async function conversationTabMutationAdmission(
  context: Pick<RpcContext, 'runtime' | 'clientKind' | 'clientCapabilities'>
): Promise<((sessionId: string) => void) | undefined> {
  if (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(NATIVE_CONVERSATION_RUNTIME_CAPABILITY)
  ) {
    return undefined
  }
  const store =
    getStructuredAgentSessionHost()?.deps.store ??
    (await context.runtime.openAgentSessionRecordStore())
  return (sessionId) => {
    if (store.conversations.membership(sessionId)) {
      throw agentSessionRefusalError('structured_agent_session_unsupported', {
        reason: 'clientCapabilityMissing'
      })
    }
  }
}
