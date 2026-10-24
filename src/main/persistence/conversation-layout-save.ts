import { collectTabGroupLayoutGroupIds } from '../../shared/workspace-layout/tab-group-moves'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { ConversationTabSurface } from '../native-chat/conversations/conversation-tab-surface'
import type { ExecutionHostId } from '../../shared/execution-host'
import { ConversationRpcRefusal } from '../../shared/conversation-rpc-refusal'

/** A snapshot cannot create, hide or rebind a host-owned conversation. No group repair by guess. */
export function assertConversationLayoutSave(
  session: WorkspaceSessionState,
  surfaces: readonly ConversationTabSurface[],
  hostId: ExecutionHostId
): void {
  const entries = Object.entries(session.unifiedTabs ?? {}).flatMap(([workspaceKey, tabs]) =>
    tabs.map((tab) => ({ workspaceKey, tab }))
  )
  const refuse = (): never => {
    throw new ConversationRpcRefusal('unsupported')
  }
  for (const surface of surfaces) {
    if (surface.location.executionHostId !== hostId) {
      refuse()
    }
    const matches = entries.filter(
      ({ tab }) =>
        tab.id === surface.tabId ||
        (tab.contentType === 'conversation' && tab.entityId === surface.conversationId)
    )
    if (!surface.visible) {
      if (matches.length) {
        refuse()
      }
      continue
    }
    if (matches.length !== 1) {
      refuse()
    }
    const { tab, workspaceKey } = matches[0]!
    if (
      tab.id !== surface.tabId ||
      tab.entityId !== surface.conversationId ||
      tab.contentType !== 'conversation' ||
      workspaceKey !== surface.location.workspaceId ||
      tab.worktreeId !== surface.location.workspaceId ||
      (tab.executionHostId ?? hostId) !== hostId
    ) {
      refuse()
    }
    const tree = session.tabGroupLayouts?.[workspaceKey]
    if (tree && !collectTabGroupLayoutGroupIds(tree).has(tab.groupId)) {
      refuse()
    }
    const groups = session.tabGroups?.[workspaceKey] ?? []
    const owners = groups.filter((group) => group.tabOrder.includes(tab.id))
    if (
      owners.length !== 1 ||
      owners[0]!.id !== tab.groupId ||
      owners[0]!.worktreeId !== surface.location.workspaceId ||
      owners[0]!.tabOrder.filter((id) => id === tab.id).length !== 1
    ) {
      refuse()
    }
  }
  for (const { tab } of entries) {
    if (
      tab.contentType === 'conversation' &&
      !surfaces.some(
        (surface) =>
          surface.visible && surface.tabId === tab.id && surface.conversationId === tab.entityId
      )
    ) {
      refuse()
    }
  }
}
