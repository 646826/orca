// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Tab } from '../../../shared/tab-types'
import { applyLocalStructuredSessionTabSnapshots } from './local-structured-session-tabs-sync/snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from './local-structured-session-tabs-sync/inventory-generation-fence'
import { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { resolveHostSessionTabIdForWebSessionTab } from './web-session-tabs-sync/tracking-mappings'
import {
  ENV,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'

const SOURCE_TAB = 'local-source-pane'
const HOST_TAB = 'host-conversation-pane'
const GROUP = 'client-chat-group'

function conversationSnapshot(
  overrides: Partial<RuntimeMobileSessionTabsResult> = {}
): RuntimeMobileSessionTabsResult {
  return makeSnapshot(
    [
      {
        type: 'conversation',
        id: HOST_TAB,
        conversationId: 'conversation-1',
        activeSessionId: 'codex-target',
        activeAgent: 'codex',
        contextGeneration: 1,
        activationFence: 2,
        surfaceRevision: 1,
        title: 'Switched conversation',
        isActive: true
      }
    ],
    {
      activeTabId: HOST_TAB,
      activeTabType: 'conversation',
      tabGroups: [{ id: 'host-group', tabOrder: [HOST_TAB], activeTabId: HOST_TAB }],
      conversationSurfaces: {
        complete: true,
        surfaces: [
          {
            conversationId: 'conversation-1',
            sourceSessionId: 'claude-source',
            tabId: HOST_TAB,
            location: {
              executionHostId: 'local',
              workspaceId: WT,
              workspaceKind: 'git-worktree',
              wslDistro: null
            },
            visible: true,
            surfaceRevision: 1,
            publishedRevision: 1
          }
        ]
      },
      ...overrides
    }
  )
}

beforeEach(() => {
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSyncTestState()
})

describe.each(['local', 'remote'] as const)('%s conversation inventory mirror', (owner) => {
  const executionHostId: ExecutionHostId = owner === 'local' ? 'local' : `runtime:${ENV}`
  const environmentId = owner === 'local' ? LOCAL_STRUCTURED_SESSION_OWNER : ENV
  const apply = (state: WebSessionTabsSyncState, snapshot: RuntimeMobileSessionTabsResult) =>
    owner === 'local'
      ? applyLocalStructuredSessionTabSnapshots(state, [snapshot], environmentId, NOW)
      : { ...state, ...applyWebSessionTabsSnapshot(state, snapshot, environmentId, NOW) }

  function sourceState(contentType: 'agent-session' | 'conversation' = 'agent-session') {
    const tab: Tab = {
      id: SOURCE_TAB,
      entityId: contentType === 'agent-session' ? 'claude-source' : 'conversation-1',
      contentType,
      executionHostId,
      agentSessionAgent: 'claude',
      groupId: GROUP,
      worktreeId: WT,
      label: 'Claude Chat',
      customLabel: 'My conversation',
      color: 'blue',
      isPinned: true,
      sortOrder: 0,
      createdAt: 10
    }
    return makeState({
      unifiedTabsByWorktree: { [WT]: [tab] },
      groupsByWorktree: {
        [WT]: [{ id: GROUP, worktreeId: WT, tabOrder: [SOURCE_TAB], activeTabId: SOURCE_TAB }]
      },
      layoutByWorktree: { [WT]: { type: 'leaf', groupId: GROUP } },
      activeGroupIdByWorktree: { [WT]: GROUP },
      activeTabId: SOURCE_TAB,
      activeTabIdByWorktree: { [WT]: SOURCE_TAB },
      activeTabType: contentType,
      activeTabTypeByWorktree: { [WT]: contentType },
      tabBarOrderByWorktree: { [WT]: [SOURCE_TAB] }
    })
  }

  it('promotes the source pane in place and keeps it through participant switches', () => {
    const original = sourceState()
    const promoted = apply(original, conversationSnapshot())
    expect(promoted.unifiedTabsByWorktree[WT]).toEqual([
      expect.objectContaining({
        id: SOURCE_TAB,
        entityId: 'conversation-1',
        contentType: 'conversation',
        agentSessionAgent: 'codex',
        executionHostId,
        groupId: GROUP,
        label: 'Switched conversation',
        customLabel: 'My conversation',
        color: 'blue',
        isPinned: true,
        createdAt: 10
      })
    ])
    expect(promoted.groupsByWorktree[WT]?.[0]).toMatchObject({
      id: GROUP,
      activeTabId: SOURCE_TAB,
      tabOrder: [SOURCE_TAB]
    })
    expect(promoted.layoutByWorktree).toEqual(original.layoutByWorktree)
    expect(promoted.activeTabType).toBe('conversation')
    expect(promoted.activeTabTypeByWorktree[WT]).toBe('conversation')
    expect(promoted.activeTabIdByWorktree[WT]).toBe(SOURCE_TAB)
    expect(promoted.tabBarOrderByWorktree[WT]).toEqual([SOURCE_TAB])
    expect(
      resolveHostSessionTabIdForWebSessionTab(promoted, {
        environmentId,
        worktreeId: WT,
        tabId: SOURCE_TAB
      })
    ).toBe(HOST_TAB)

    const repeated = apply(promoted, conversationSnapshot({ snapshotVersion: 2 }))
    expect(repeated.unifiedTabsByWorktree[WT]).toEqual(promoted.unifiedTabsByWorktree[WT])
    const nextSnapshot = conversationSnapshot({ snapshotVersion: 3 })
    nextSnapshot.tabs = nextSnapshot.tabs.map((tab) =>
      tab.type === 'conversation'
        ? { ...tab, activeSessionId: 'claude-next', activeAgent: 'claude', activationFence: 3 }
        : tab
    )
    const switched = apply(repeated, nextSnapshot)
    expect(switched.unifiedTabsByWorktree[WT]).toEqual([
      expect.objectContaining({
        id: SOURCE_TAB,
        entityId: 'conversation-1',
        agentSessionAgent: 'claude'
      })
    ])
    expect(switched.groupsByWorktree[WT]?.[0]?.activeTabId).toBe(SOURCE_TAB)
  })

  it.each([WT, 'folder:conversation-workspace'])(
    'restores conversation-only workspace %s with conversation focus',
    (workspaceId) => {
      const snapshot = conversationSnapshot({ worktree: workspaceId })
      if (snapshot.conversationSurfaces?.complete) {
        for (const surface of snapshot.conversationSurfaces.surfaces) {
          surface.location.workspaceId = workspaceId
          surface.location.workspaceKind = workspaceId === WT ? 'git-worktree' : 'folder'
        }
      }
      const restored = apply(makeState({ activeWorktreeId: workspaceId }), snapshot)
      expect(restored.unifiedTabsByWorktree[workspaceId]).toEqual([
        expect.objectContaining({
          id: HOST_TAB,
          entityId: 'conversation-1',
          contentType: 'conversation'
        })
      ])
      expect(restored.groupsByWorktree[workspaceId]?.[0]?.activeTabId).toBe(HOST_TAB)
      expect(restored.activeTabType).toBe('conversation')
    }
  )

  it.each([false, true])('honors explicit conversation focus only: %s', (follow) => {
    const state = sourceState()
    const [source] = state.unifiedTabsByWorktree[WT]!
    if (!source) {
      throw new Error('Missing source fixture')
    }
    state.unifiedTabsByWorktree[WT]!.push({
      ...source,
      id: 'other-pane',
      entityId: 'other-session',
      customLabel: null
    })
    state.groupsByWorktree[WT]![0]!.tabOrder.push('other-pane')
    state.groupsByWorktree[WT]![0]!.activeTabId = 'other-pane'
    state.activeTabIdByWorktree[WT] = 'other-pane'
    const snapshot = conversationSnapshot({ navigationIntent: follow ? 'follow' : undefined })
    snapshot.tabs.push({
      type: 'agent-session',
      id: 'host-other',
      sessionId: 'other-session',
      agent: 'claude',
      title: 'Other chat',
      isActive: false
    })
    const next = apply(state, snapshot)
    expect(next.groupsByWorktree[WT]?.[0]?.activeTabId).toBe(follow ? SOURCE_TAB : 'other-pane')
    expect(next.activeTabType).toBe(follow ? 'conversation' : 'agent-session')
  })

  it("does not retire another execution host's conversation on a complete inventory", () => {
    const state = sourceState('conversation')
    state.unifiedTabsByWorktree[WT]![0]!.executionHostId = 'runtime:other-host'
    const next = apply(
      state,
      conversationSnapshot({
        tabs: [],
        conversationSurfaces: { complete: true, surfaces: [] }
      })
    )
    expect(next.unifiedTabsByWorktree[WT]).toEqual(state.unifiedTabsByWorktree[WT])
  })

  it('does not adopt a same-ID conversation from another execution host', () => {
    const state = sourceState()
    const source = state.unifiedTabsByWorktree[WT]![0]!
    state.unifiedTabsByWorktree[WT]!.unshift({
      ...source,
      id: 'foreign-pane',
      entityId: 'conversation-1',
      contentType: 'conversation',
      executionHostId: 'runtime:other-host'
    })
    const next = apply(state, conversationSnapshot())
    expect(next.unifiedTabsByWorktree[WT]).toEqual([
      expect.objectContaining({ id: 'foreign-pane', executionHostId: 'runtime:other-host' }),
      expect.objectContaining({ id: SOURCE_TAB, entityId: 'conversation-1', executionHostId })
    ])
  })

  it("preserves a foreign source chat when promoting the owning host's source", () => {
    const state = sourceState()
    const source = state.unifiedTabsByWorktree[WT]![0]!
    state.unifiedTabsByWorktree[WT]!.unshift({
      ...source,
      id: 'foreign-source-pane',
      executionHostId: 'runtime:other-host'
    })
    const next = apply(state, conversationSnapshot())
    expect(next.unifiedTabsByWorktree[WT]).toEqual([
      expect.objectContaining({
        id: 'foreign-source-pane',
        entityId: 'claude-source',
        contentType: 'agent-session',
        executionHostId: 'runtime:other-host'
      }),
      expect.objectContaining({
        id: SOURCE_TAB,
        entityId: 'conversation-1',
        contentType: 'conversation',
        executionHostId
      })
    ])
  })

  it('retires absent native chats only for the publishing execution host', () => {
    const state = sourceState()
    const source = state.unifiedTabsByWorktree[WT]![0]!
    state.unifiedTabsByWorktree[WT]!.push({
      ...source,
      id: 'foreign-source-pane',
      executionHostId: 'runtime:other-host'
    })
    const next = apply(
      state,
      conversationSnapshot({
        tabs: [],
        conversationSurfaces: { complete: true, surfaces: [] }
      })
    )
    expect(next.unifiedTabsByWorktree[WT]).toEqual([
      expect.objectContaining({ id: 'foreign-source-pane', contentType: 'agent-session' })
    ])
  })

  it.each([
    undefined,
    { complete: false as const, reason: 'unavailable' as const },
    { complete: false as const, reason: 'resource-limit' as const }
  ])('retains an existing conversation when inventory cannot prove absence: %j', (inventory) => {
    const state = sourceState('conversation')
    const next = apply(state, conversationSnapshot({ tabs: [], conversationSurfaces: inventory }))
    expect(next.unifiedTabsByWorktree[WT]).toEqual(state.unifiedTabsByWorktree[WT])
    expect(next.groupsByWorktree[WT]?.[0]?.activeTabId).toBe(SOURCE_TAB)
    expect(next.activeTabType).toBe('conversation')
  })

  it.each(['agent-session', 'conversation'] as const)(
    'keeps the selected %s pane before restored group records arrive',
    (contentType) => {
      const state = sourceState(contentType)
      state.groupsByWorktree = {}
      state.unifiedTabsByWorktree[WT]!.unshift({
        ...state.unifiedTabsByWorktree[WT]![0]!,
        id: 'local-other-conversation',
        entityId: 'conversation-2',
        contentType: 'conversation'
      })
      const snapshot = conversationSnapshot({ activeTabId: 'host-other-conversation' })
      snapshot.tabs = snapshot.tabs.map((tab) => ({ ...tab, isActive: false }))
      snapshot.tabs.push({
        type: 'conversation',
        id: 'host-other-conversation',
        conversationId: 'conversation-2',
        activeSessionId: 'other-session',
        activeAgent: 'claude',
        contextGeneration: 1,
        activationFence: 1,
        surfaceRevision: 1,
        title: 'Other conversation',
        isActive: true
      })
      snapshot.tabGroups = [
        {
          id: 'host-group',
          activeTabId: 'host-other-conversation',
          tabOrder: [HOST_TAB, 'host-other-conversation']
        }
      ]
      if (snapshot.conversationSurfaces?.complete) {
        const surface = snapshot.conversationSurfaces.surfaces[0]!
        snapshot.conversationSurfaces.surfaces.push({
          ...surface,
          conversationId: 'conversation-2',
          sourceSessionId: 'other-session',
          tabId: 'host-other-conversation'
        })
      }
      const next = apply(state, snapshot)
      expect(next.activeTabIdByWorktree[WT]).toBe(SOURCE_TAB)
      expect(
        next.groupsByWorktree[WT]?.find((group) => group.id === next.activeGroupIdByWorktree[WT])
          ?.activeTabId
      ).toBe(SOURCE_TAB)
    }
  )

  it('retains the canonical host mapping while its conversation inventory is incomplete', () => {
    const promoted = apply(sourceState(), conversationSnapshot())
    const retained = apply(
      promoted,
      conversationSnapshot({
        snapshotVersion: 2,
        tabs: [],
        conversationSurfaces: { complete: false, reason: 'unavailable' }
      })
    )
    expect(
      resolveHostSessionTabIdForWebSessionTab(retained, {
        environmentId,
        worktreeId: WT,
        tabId: SOURCE_TAB
      })
    ).toBe(HOST_TAB)
  })

  it('removes a conversation when complete inventory confirms its surface is hidden', () => {
    const snapshot = conversationSnapshot({ tabs: [], activeTabId: null, activeTabType: null })
    if (snapshot.conversationSurfaces?.complete) {
      snapshot.conversationSurfaces.surfaces = snapshot.conversationSurfaces.surfaces.map(
        (surface) => ({ ...surface, visible: false, surfaceRevision: 2, publishedRevision: 2 })
      )
    }
    const next = apply(sourceState('conversation'), snapshot)
    expect(next.unifiedTabsByWorktree[WT] ?? []).toEqual([])
    expect(next.tabBarOrderByWorktree[WT] ?? []).toEqual([])
  })
})
