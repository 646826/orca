import { collectTabGroupLayoutGroupIds } from '../../../../shared/workspace-layout/tab-group-moves'
import { supportsConversationRead } from '../../../../shared/conversation-runtime-capabilities'
import {
  MAX_CONVERSATION_INVENTORY_BYTES,
  type RuntimeMobileSessionConversationTab
} from '../../../../shared/conversation-inventory'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { getMobileSessionTabOrderIds } from '../../mobile-session-tab-merge'
import { pruneGroupLayout } from '../../../../shared/workspace-session-terminal-tab-close'
import { requireConversationRecord } from './conversation-method-access'
import type { RpcContext } from '../core'

export function conversationInventoryEnabled(context: Pick<RpcContext, 'clientCapabilities'>) {
  return supportsConversationRead(context.clientCapabilities)
}

/** Surface ownership comes from the journal DB; layout supplies only presentation and grouping. */
export function projectConversationSessionTabs(
  snapshot: RuntimeMobileSessionTabsResult,
  context: RpcContext
): RuntimeMobileSessionTabsResult {
  if (!conversationInventoryEnabled(context)) {
    return snapshot
  }
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return { ...snapshot, conversationSurfaces: { complete: false, reason: 'unavailable' } }
  }
  const surfaces = host.listConversationSurfaces({
    executionHostId: 'local',
    workspaceId: snapshot.worktree,
    includeHidden: true
  })
  if (Buffer.byteLength(JSON.stringify(surfaces)) > MAX_CONVERSATION_INVENTORY_BYTES) {
    return { ...snapshot, conversationSurfaces: { complete: false, reason: 'resource-limit' } }
  }
  const session = context.runtime.getWorkspaceSessionForWorktree(snapshot.worktree)
  const rows: RuntimeMobileSessionConversationTab[] = []
  for (const surface of surfaces) {
    const conversation = requireConversationRecord(host, context, surface.conversationId)
    if (!surface.visible) {
      continue
    }
    const segment = host.deps.store.conversations
      .segments(surface.conversationId)
      .find((value) => value.segmentId === conversation.activeSegmentId)
    const record = segment && host.deps.store.getRecord(segment.sessionId)
    const tab = session?.unifiedTabs?.[snapshot.worktree]?.find(
      (value) => value.id === surface.tabId
    )
    if (
      !record ||
      (record.provider !== 'claude' &&
        record.provider !== 'codex' &&
        record.provider !== 'opencode') ||
      !tab ||
      tab.contentType !== 'conversation' ||
      tab.entityId !== surface.conversationId ||
      surface.publishedRevision !== surface.surfaceRevision
    ) {
      return { ...snapshot, conversationSurfaces: { complete: false, reason: 'unavailable' } }
    }
    rows.push({
      type: 'conversation',
      id: surface.tabId,
      conversationId: surface.conversationId,
      title: tab.customLabel ?? tab.label,
      activeSessionId: record.sessionId,
      activeAgent: record.provider,
      contextGeneration: conversation.contextGeneration,
      activationFence: conversation.activationFence,
      surfaceRevision: surface.surfaceRevision,
      color: tab.color,
      isPinned: tab.isPinned,
      isActive: session?.activeTabIdByWorktree?.[snapshot.worktree] === surface.tabId
    })
  }
  const protectedIds = new Set(surfaces.map((surface) => surface.tabId))
  const conversationIds = new Set(surfaces.map((surface) => surface.conversationId))
  const tabs = [
    ...snapshot.tabs.filter((tab) => {
      if (protectedIds.has(tab.id)) {
        return false
      }
      const membership =
        tab.type === 'agent-session'
          ? host.deps.store.conversations.membership(tab.sessionId)
          : null
      return !membership || !conversationIds.has(membership.conversationId)
    }),
    ...rows
  ]
  if (!surfaces.length) {
    return { ...snapshot, tabs, conversationSurfaces: { complete: true, surfaces: [...surfaces] } }
  }
  const shown = new Set(tabs.flatMap(getMobileSessionTabOrderIds))
  const groupById = new Map(
    (snapshot.tabGroups ?? []).map((group) => [
      group.id,
      {
        ...group,
        tabOrder: group.tabOrder.filter((id) => shown.has(id) && !protectedIds.has(id))
      }
    ])
  )
  for (const saved of session?.tabGroups?.[snapshot.worktree] ?? []) {
    const prior = groupById.get(saved.id)
    const savedOrder = saved.tabOrder.filter((id) => shown.has(id))
    groupById.set(saved.id, {
      id: saved.id,
      tabOrder: [
        ...savedOrder,
        ...(prior?.tabOrder ?? []).filter((id) => !savedOrder.includes(id))
      ],
      activeTabId:
        saved.activeTabId && shown.has(saved.activeTabId)
          ? saved.activeTabId
          : (prior?.activeTabId ?? null)
    })
  }
  // Saved groups place aggregate surfaces; retain runtime-only terminal/browser groups as well.
  const assigned = new Set<string>()
  const groups = [...groupById.values()]
    .map((group) => {
      const tabOrder = group.tabOrder.filter((id) => {
        if (assigned.has(id)) {
          return false
        }
        assigned.add(id)
        return true
      })
      return {
        ...group,
        tabOrder,
        activeTabId:
          group.activeTabId && tabOrder.includes(group.activeTabId)
            ? group.activeTabId
            : (tabOrder[0] ?? null)
      }
    })
    .filter((group) => group.tabOrder.length)
  const validGroups = new Set(groups.map((group) => group.id))
  let layout = pruneGroupLayout(session?.tabGroupLayouts?.[snapshot.worktree], validGroups)
  const extras = new Set(
    [...validGroups].filter((id) => !collectTabGroupLayoutGroupIds(layout).has(id))
  )
  const extraLayout = pruneGroupLayout(snapshot.tabGroupLayout ?? undefined, extras)
  if (extraLayout) {
    layout = layout
      ? { type: 'split', direction: 'horizontal', first: layout, second: extraLayout }
      : extraLayout
  }
  for (const group of groups) {
    if (!collectTabGroupLayoutGroupIds(layout).has(group.id)) {
      const leaf = { type: 'leaf' as const, groupId: group.id }
      layout = layout
        ? { type: 'split', direction: 'horizontal', first: layout, second: leaf }
        : leaf
    }
  }
  const activeId =
    rows.find((row) => row.isActive)?.id ??
    (snapshot.activeTabId && shown.has(snapshot.activeTabId)
      ? snapshot.activeTabId
      : (groups[0]?.activeTabId ?? null))
  const active = tabs.find((tab) => getMobileSessionTabOrderIds(tab).includes(activeId ?? ''))
  const projected: RuntimeMobileSessionTabsResult = {
    ...snapshot,
    tabs: tabs.map((tab) => ({
      ...tab,
      isActive: getMobileSessionTabOrderIds(tab).includes(activeId ?? '')
    })),
    activeTabId: activeId,
    activeTabType: active?.type ?? null,
    activeGroupId: groups.find((group) => group.tabOrder.includes(activeId ?? ''))?.id ?? null,
    tabGroups: groups,
    tabGroupLayout: layout ?? null,
    conversationSurfaces: { complete: true, surfaces: [...surfaces] }
  }
  return context.pairedDeviceId
    ? context.runtime.projectConversationSessionTabNavigation(projected, context.pairedDeviceId)
    : projected
}

export async function includeConversationWorkspaces(
  snapshots: RuntimeMobileSessionTabsResult[],
  context: RpcContext
) {
  if (!conversationInventoryEnabled(context)) {
    return snapshots
  }
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return snapshots
  }
  const ids = new Set(snapshots.map((value) => value.worktree))
  const result = [...snapshots]
  for (const surface of host.listConversationSurfaces({
    executionHostId: 'local',
    includeHidden: true
  })) {
    if (!ids.has(surface.location.workspaceId)) {
      ids.add(surface.location.workspaceId)
      result.push(
        await context.runtime.listMobileSessionTabs(
          `id:${surface.location.workspaceId}`,
          context.pairedDeviceId
        )
      )
    }
  }
  return result
}

export function conversationInventoryComplete(
  snapshots: RuntimeMobileSessionTabsResult[],
  context: RpcContext
): boolean {
  if (!conversationInventoryEnabled(context)) {
    return false
  }
  const host = getStructuredAgentSessionHost()
  if (!host || snapshots.some((value) => value.conversationSurfaces?.complete !== true)) {
    return false
  }
  const expected = host.listConversationSurfaces({ executionHostId: 'local', includeHidden: true })
  const actual = snapshots.flatMap((value) =>
    value.conversationSurfaces?.complete ? value.conversationSurfaces.surfaces : []
  )
  if (
    Buffer.byteLength(JSON.stringify(actual)) > MAX_CONVERSATION_INVENTORY_BYTES ||
    actual.length !== expected.length
  ) {
    return false
  }
  const byId = new Map(actual.map((value) => [value.conversationId, JSON.stringify(value)]))
  return expected.every((value) => byId.get(value.conversationId) === JSON.stringify(value))
}
