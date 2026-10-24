import { applied, refuse, type Applied } from './workspace-layout-command-steps'
import type { CommandOf, LayoutContext, NewGroupSplit } from './workspace-layout-command-types'
import type { LayoutContentTab, WorkspaceLayoutModel } from './workspace-layout-model'
import { drawnTabOpen, withSendersGroup } from './workspace-layout-content-commands'
import { withWorkspace } from './workspace-layout-removal'
import { placeContentTab } from './workspace-layout-tab-commands'

/** The aggregate surface's two pure layout operations; lifecycle authority remains host-owned. */
export type ConversationLayoutCommand =
  | ({ workspace: string } & {
      type: 'promoteConversationTab'
      tabId: string
      sourceSessionId: string
      conversationId: string
    })
  | ({ workspace: string } & {
      type: 'openConversationTab'
      conversationId: string
      tabId?: string
      groupId?: string
      afterTabId?: string
      index?: number
      createdAt?: number
      split?: NewGroupSplit
    })
/** Host authorization precedes this pure projection; promotion keeps the existing visual identity. */
export function promoteConversationTab(
  model: WorkspaceLayoutModel,
  command: CommandOf<'promoteConversationTab'>
): Applied {
  const workspace = model.workspaces[command.workspace]
  const tab = workspace?.tabs.find((entry) => entry.id === command.tabId)
  if (!workspace || !tab) {
    return refuse('tab_not_found')
  }
  if (tab.kind === 'conversation' && tab.entityId === command.conversationId) {
    return applied(model, { tabId: tab.id })
  }
  if (tab.kind !== 'agent-session' || tab.entityId !== command.sourceSessionId) {
    return refuse('invalid_params')
  }
  if (
    workspace.tabs.some(
      (entry) => entry.kind === 'conversation' && entry.entityId === command.conversationId
    )
  ) {
    return refuse('tab_exists')
  }
  const { agentSessionAgent: _agent, ...fields } = tab
  const promoted: LayoutContentTab = {
    ...fields,
    kind: 'conversation',
    entityId: command.conversationId
  }
  return applied(
    withWorkspace(model, command.workspace, {
      ...workspace,
      tabs: workspace.tabs.map((entry) => (entry.id === tab.id ? promoted : entry))
    }),
    { tabId: tab.id }
  )
}

export function openConversationTab(
  model: WorkspaceLayoutModel,
  command: CommandOf<'openConversationTab'>,
  context: LayoutContext
): Applied {
  const existing = model.workspaces[command.workspace]?.tabs.find(
    (tab) => tab.kind === 'conversation' && tab.entityId === command.conversationId
  )
  if (existing) {
    return command.tabId && existing.id !== command.tabId
      ? refuse('tab_exists')
      : applied(model, { tabId: existing.id })
  }
  const drawn = drawnTabOpen(
    model,
    command.workspace,
    command.tabId,
    (tab) => tab.kind === 'conversation' && tab.entityId === command.conversationId,
    true
  )
  if (drawn) {
    return drawn
  }
  const tab: LayoutContentTab = {
    id: command.tabId ?? context.mintId(),
    kind: 'conversation',
    entityId: command.conversationId,
    createdAt: command.createdAt ?? context.now(),
    customTitle: null,
    color: null
  }
  const target = withSendersGroup(model, command.workspace, command.groupId)
  return applied(placeContentTab(target, command.workspace, tab, command, context).model, {
    tabId: tab.id
  })
}
