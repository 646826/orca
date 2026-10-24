import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import type { StructuredAgentSessionConversationLifetime } from './structured-agent-session-conversation-lifetime'
import type { StructuredAgentSessionConversationDelivery } from './structured-agent-session-host-delivery'
import { sleepStructuredAgentSessionWorkspace } from './structured-agent-session-workspace-sleep'

type WorkspaceSleepContext = Pick<
  StructuredAgentSessionAttachContext,
  'deps' | 'tasks' | 'runtimeState'
> & {
  sessions: Parameters<typeof sleepStructuredAgentSessionWorkspace>[0]['sessions']
  lifetime: StructuredAgentSessionConversationLifetime
  clientDelivery: StructuredAgentSessionClientDelivery
  conversationDelivery: StructuredAgentSessionConversationDelivery
}

export function structuredAgentSessionWorkspaceSleepDelegate(context: () => WorkspaceSleepContext) {
  return (
    workspaceId: string,
    markAsleep?: boolean,
    assertMutationSupported?: (sessionId: string) => void
  ) => {
    const host = context()
    return sleepStructuredAgentSessionWorkspace(
      {
        deps: host.deps,
        tasks: host.tasks,
        lifetime: host.lifetime,
        sessions: host.sessions,
        deliveryRunning: (id) =>
          host.conversationDelivery.loop.isRunning(id) || host.runtimeState.startFlights.has(id),
        childWorkIncomplete: host.clientDelivery.childWorkIncomplete,
        publishRecordNotes: host.clientDelivery.publishRecordNotes
      },
      workspaceId,
      markAsleep,
      assertMutationSupported
    )
  }
}
