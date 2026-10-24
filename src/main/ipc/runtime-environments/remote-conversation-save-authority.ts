import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { NATIVE_CONVERSATION_RUNTIME_CAPABILITY } from '../../../shared/conversation-runtime-capabilities'
import { ConversationRpcRefusal } from '../../../shared/conversation-rpc-refusal'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import { getRuntimeEnvironmentStatusOwner } from './runtime-environment-request-connections'
import { getRuntimeEnvironmentTransportGeneration } from './runtime-environment-transport-generation'
import { readRemoteConversationInventory } from './remote-conversation-layout-admission'

const hasConversation = (session: WorkspaceSessionState) =>
  Object.values(session.unifiedTabs ?? {}).some((tabs) =>
    tabs.some((tab) => tab.contentType === 'conversation')
  )

/** Reads existing authenticated inventory; never dials a host to approve a renderer save. */
export function remoteConversationSaveAuthority(input: {
  userDataPath: string
  hostId: ExecutionHostId
  current: WorkspaceSessionState
  incoming: WorkspaceSessionState
}) {
  const host = parseExecutionHostId(input.hostId)
  if (host?.kind !== 'runtime') {
    throw new ConversationRpcRefusal('scope-mismatch')
  }
  const surfaces = readRemoteConversationInventory(
    host.environmentId,
    getRuntimeEnvironmentTransportGeneration(host.environmentId)
  )
  const environment = resolveEnvironment(input.userDataPath, host.environmentId)
  const status = getRuntimeEnvironmentStatusOwner(input.userDataPath, host.environmentId).read()
  if (
    status.retired ||
    status.verification !== 'verified' ||
    status.pairingRevision !== (environment.pairingRevision ?? environment.createdAt) ||
    status.status?.runtimeId !== environment.runtimeId
  ) {
    throw new ConversationRpcRefusal('unsupported')
  }
  const capable =
    status.status?.capabilities?.includes(NATIVE_CONVERSATION_RUNTIME_CAPABILITY) === true
  if (!capable && !hasConversation(input.current) && !hasConversation(input.incoming)) {
    return []
  }
  if (!capable || !surfaces) {
    throw new ConversationRpcRefusal('unsupported')
  }
  return surfaces
}

/** Legacy terminal close can reach mirrored partitions; it cannot close an aggregate surface. */
export function assertRemoteConversationLayoutClose(input: {
  userDataPath: string
  hostIds: readonly ExecutionHostId[]
  readSession: (hostId: ExecutionHostId) => WorkspaceSessionState
  workspaceId: string
  tabId: string
}): void {
  for (const hostId of input.hostIds) {
    const host = parseExecutionHostId(hostId)
    if (host?.kind !== 'runtime') {
      continue
    }
    const current = input.readSession(hostId)
    const listed = current.unifiedTabs?.[input.workspaceId]?.find((tab) => tab.id === input.tabId)
    const known = readRemoteConversationInventory(
      host.environmentId,
      getRuntimeEnvironmentTransportGeneration(host.environmentId)
    )
    if (
      known?.some(
        (surface) =>
          surface.tabId === input.tabId && surface.location.workspaceId === input.workspaceId
      ) ||
      listed?.contentType === 'conversation'
    ) {
      throw new ConversationRpcRefusal('unsupported')
    }
    if (listed) {
      remoteConversationSaveAuthority({
        userDataPath: input.userDataPath,
        hostId,
        current,
        incoming: current
      })
    }
  }
}
