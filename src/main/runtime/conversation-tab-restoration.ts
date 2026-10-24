import { collectSavedStructuredAgentSessionIds } from './saved-structured-agent-session-restoration'
import type { RuntimeStore } from './runtime-store-contract'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { assertConversationLayoutSave } from '../persistence/conversation-layout-save'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { loadWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import type { LayoutCommand } from '../../shared/workspace-layout/workspace-layout-command-types'
import type { ConversationTabSurface } from '../native-chat/conversations/conversation-tab-surface'
import { ConversationRefusal } from '../native-chat/conversations/conversation-read-model'

export type ConversationSurfacePublication = {
  hostId: ExecutionHostId
  list: () => readonly ConversationTabSurface[]
  readSession: () => WorkspaceSessionState
  flush: () => Promise<void>
  acknowledge: (input: {
    conversationId: string
    expectedSurfaceRevision: number
  }) => Promise<unknown>
}

export async function acknowledgeConversationSurfacePublication(
  input: ConversationSurfacePublication
): Promise<void> {
  await input.flush()
  const session = input.readSession()
  const surfaces = input.list()
  assertConversationLayoutSave(session, surfaces, input.hostId)
  for (const surface of surfaces) {
    if (surface.location.executionHostId !== input.hostId) {
      throw new ConversationRefusal('scope-mismatch')
    }
    const tabs = session.unifiedTabs?.[surface.location.workspaceId] ?? []
    const tab = tabs.find((candidate) => candidate.id === surface.tabId)
    const correct = surface.visible
      ? tab?.contentType === 'conversation' && tab.entityId === surface.conversationId
      : tab === undefined
    if (!correct) {
      throw new ConversationRefusal('scope-mismatch')
    }
    await input.acknowledge({
      conversationId: surface.conversationId,
      expectedSurfaceRevision: surface.surfaceRevision
    })
  }
}

export async function restoreConversationTabSurfaces(
  input: ConversationSurfacePublication & {
    applyLayoutCommand: NonNullable<RuntimeStore['applyLayoutCommand']>
  }
): Promise<void> {
  for (const surface of input.list()) {
    const tab = readConversationSurfaceTab(input, surface)
    const workspace = surface.location.workspaceId
    let command: LayoutCommand | null = null
    if (!surface.visible) {
      if (tab) {
        command = { type: 'closeTabs', workspace, tabIds: [surface.tabId], force: true }
      }
    } else if (tab?.kind === 'agent-session') {
      command = {
        type: 'promoteConversationTab',
        workspace,
        tabId: surface.tabId,
        sourceSessionId: surface.sourceSessionId,
        conversationId: surface.conversationId
      }
    } else if (!tab) {
      command = {
        type: 'openConversationTab',
        workspace,
        tabId: surface.tabId,
        conversationId: surface.conversationId
      }
    }
    if (command) {
      const result = await input.applyLayoutCommand(command, [input.hostId], {
        beforeMutation: () => {
          const current = input
            .list()
            .find((entry) => entry.conversationId === surface.conversationId)
          if (current?.surfaceRevision !== surface.surfaceRevision) {
            throw new ConversationRefusal('stale-generation')
          }
          readConversationSurfaceTab(input, surface)
        }
      })
      if (!result.ok) {
        throw new ConversationRefusal('scope-mismatch')
      }
    }
  }
  await acknowledgeConversationSurfacePublication(input)
}

function readConversationSurfaceTab(
  input: ConversationSurfacePublication,
  surface: ConversationTabSurface
) {
  if (surface.location.executionHostId !== input.hostId) {
    throw new ConversationRefusal('scope-mismatch')
  }
  const { layout } = loadWorkspaceLayout(input.hostId, input.readSession(), nameBasedLoadContext())
  const tab = layout.workspaces[surface.location.workspaceId]?.tabs.find(
    (candidate) => candidate.id === surface.tabId
  )
  if (
    tab &&
    !(
      (tab.kind === 'conversation' && tab.entityId === surface.conversationId) ||
      (tab.kind === 'agent-session' && tab.entityId === surface.sourceSessionId)
    )
  ) {
    throw new ConversationRefusal('scope-mismatch')
  }
  return tab
}

/** Compose the durable surface publisher without eagerly opening persistence for an empty host. */
export async function publishRuntimeConversationSurfaces(
  hostId: ExecutionHostId,
  host: StructuredAgentSessionHost | null,
  requireStore: () => Pick<
    RuntimeStore,
    'getWorkspaceSession' | 'applyLayoutCommand' | 'flushPendingOrThrowAsync'
  >,
  afterPublication?: (workspaceId: string) => void
): Promise<void> {
  if (host) {
    const surfaces = host.listConversationSurfaces({
      executionHostId: hostId,
      includeHidden: true
    })
    if (surfaces.length) {
      const store = requireStore()
      const read = store.getWorkspaceSession?.bind(store)
      const apply = store.applyLayoutCommand?.bind(store)
      const flush = store.flushPendingOrThrowAsync?.bind(store)
      if (!read || !apply || !flush) {
        throw new Error('Conversation restoration requires durable workspace persistence')
      }
      await restoreConversationTabSurfaces({
        hostId: hostId,
        list: () =>
          host.listConversationSurfaces({
            executionHostId: hostId,
            includeHidden: true
          }),
        readSession: () => read(hostId),
        applyLayoutCommand: apply,
        flush: flush,
        acknowledge: (request) => host.deps.store.conversations.surfaces.acknowledge(request)
      })
      for (const workspaceId of new Set(surfaces.map((surface) => surface.location.workspaceId))) {
        afterPublication?.(workspaceId)
      }
    }
  }
}

/** Normalize legacy tab identifiers before publishing the host's restored native inventory. */
export function readRestoredNativeTabs(host: StructuredAgentSessionHost | null) {
  return (host?.listSessionTabs() ?? []).map((session) => {
    let sessionId = session.sessionId
    while (sessionId.startsWith('agent-session:')) {
      sessionId = sessionId.slice('agent-session:'.length)
    }
    return { ...session, agent: session.agent, sessionId }
  })
}

/** An explicitly empty durable visible index wins over stale layout references. */
export function readNativeRestorationTargets(
  host: StructuredAgentSessionHost | null,
  session: WorkspaceSessionState | null
): string[] {
  const index =
    typeof host?.getPersistedVisibleSessionTabIndex === 'function'
      ? host.getPersistedVisibleSessionTabIndex()
      : { present: false, sessionIds: [] }
  const profileIds = collectSavedStructuredAgentSessionIds(session)
  return index.present ? index.sessionIds : profileIds
}
