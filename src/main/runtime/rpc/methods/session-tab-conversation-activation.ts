import type { z } from 'zod'
import type { ActivateTab } from '../../../../shared/rpc-contract/session-tabs-schemas-params'
import { ConversationRpcRefusal } from '../../../../shared/conversation-rpc-refusal'
import { resolveRuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { RpcContext } from '../core'
import { conversationRpcCaller, conversationRpcHost } from './conversation-method-access'
import { projectConversationSessionTabs } from './session-tabs-conversation-projection'
import { projectSessionTabsForClient } from './session-tab-agent-status-projection'

/** Admit only durable aggregate surfaces; native/terminal activation keeps its existing path. */
export async function activateConversationSessionTab(
  params: z.infer<typeof ActivateTab>,
  context: RpcContext
) {
  const installed = getStructuredAgentSessionHost()
  const surface = installed
    ?.listConversationSurfaces({ executionHostId: 'local', includeHidden: true })
    .find((candidate) => candidate.tabId === params.tabId)
  if (!surface) {
    return null
  }
  conversationRpcCaller(context)
  await conversationRpcHost(context)
  const navigation = resolveRuntimeNavigationTarget({
    navigation: params.navigation,
    notifyClients: params.notifyClients,
    clientKind: context.clientKind
  })
  if (params.leafId || navigation !== 'caller') {
    throw new ConversationRpcRefusal('unsupported')
  }
  // No caller projection yet: navigation adds its epoch/revision exactly once below.
  const raw = await context.runtime.listMobileSessionTabs(params.worktree)
  if (raw.worktree !== surface.location.workspaceId) {
    throw new ConversationRpcRefusal('scope-mismatch')
  }
  const snapshot = projectConversationSessionTabs(
    projectSessionTabsForClient(raw, context.clientKind, context.clientCapabilities),
    { ...context, pairedDeviceId: undefined }
  )
  if (
    !snapshot.tabs.some(
      (tab) =>
        tab.type === 'conversation' &&
        tab.id === params.tabId &&
        tab.conversationId === surface.conversationId
    )
  ) {
    throw new ConversationRpcRefusal('source-unavailable')
  }
  return context.runtime.activateProjectedConversationSessionTab(
    snapshot,
    params.tabId,
    context.pairedDeviceId
  )
}
