// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-types'
import type { Tab } from '../../../../../shared/tab-types'
import { ConversationSurfaceVisibilityParams } from '../../../../../shared/conversation-surface-rpc'
import { entrySnapshot } from '../../../components/native-chat/native-chat-conversation-entry.test-fixture'
import { createTestStore, makeWorktree, seedStore, TEST_REPO } from '../store-test-helpers'
import { applyWebSessionTabsSnapshot } from '../../../runtime/web-session-tabs-sync/snapshot-api'
import { applyLocalStructuredSessionTabSnapshots } from '../../../runtime/local-structured-session-tabs-sync/snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from '../../../runtime/local-structured-session-tabs-sync/inventory-generation-fence'
import { structuredAgentSessionFocusOwner } from '../../../runtime/structured-agent-session-owner'
import { resetWebSessionTabsSyncTestState } from '../../../runtime/web-session-tabs-sync-test-harness'
import { isTabClosePending } from '../../../runtime/layout-owner-pending-tabs'
import { replaceRuntimeEnvironmentRevisions } from '../../../runtime/runtime-environment-revision'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), localRefresh: vi.fn(), remoteRefresh: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionWorktreeTabs: mocks.localRefresh
}))
vi.mock('@/runtime/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: mocks.remoteRefresh
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))

const LOCAL_TAB = 'client-source-pane'
const HOST_TAB = 'host-surface-pane'
const WORKSPACE = 'w'
const GROUP = 'client-group'

beforeEach(() => {
  vi.clearAllMocks()
  resetWebSessionTabsSyncTestState()
  resetLocalStructuredSessionVersionForTests()
  replaceRuntimeEnvironmentRevisions([{ id: 'paired', createdAt: 10, pairingRevision: 10 }])
})

describe.each(['local', 'remote'] as const)('%s conversation close inventory', (kind) => {
  it.each([
    { incomplete: false, missingHideFrame: false, foreignCanonical: false },
    { incomplete: true, missingHideFrame: false, foreignCanonical: false },
    { incomplete: true, missingHideFrame: true, foreignCanonical: false },
    { incomplete: false, missingHideFrame: false, foreignCanonical: true }
  ])(
    'closes and reopens a mapped pane: %j',
    async ({ incomplete, missingHideFrame, foreignCanonical }) => {
      const target: RuntimeClientTarget =
        kind === 'local' ? { kind: 'local' } : { kind: 'environment', environmentId: 'paired' }
      const executionHostId: ExecutionHostId = kind === 'local' ? 'local' : 'runtime:paired'
      const environmentId = structuredAgentSessionFocusOwner(target).environmentId
      const store = createTestStore()
      const source: Tab = {
        id: LOCAL_TAB,
        entityId: 'a',
        contentType: 'agent-session',
        agentSessionAgent: 'claude',
        executionHostId,
        worktreeId: WORKSPACE,
        groupId: GROUP,
        label: 'Chat',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
      seedStore(store, {
        repos: [{ ...TEST_REPO, id: 'repo', path: '/w', executionHostId }],
        worktreesByRepo: {
          repo: [
            makeWorktree({ id: WORKSPACE, repoId: 'repo', path: '/w', hostId: executionHostId })
          ]
        },
        unifiedTabsByWorktree: { [WORKSPACE]: [source] },
        groupsByWorktree: {
          [WORKSPACE]: [
            { id: GROUP, worktreeId: WORKSPACE, tabOrder: [LOCAL_TAB], activeTabId: LOCAL_TAB }
          ]
        },
        layoutByWorktree: { [WORKSPACE]: { type: 'leaf', groupId: GROUP } },
        activeWorktreeId: WORKSPACE,
        activeGroupIdByWorktree: { [WORKSPACE]: GROUP },
        activeTabType: 'agent-session',
        activeTabTypeByWorktree: { [WORKSPACE]: 'agent-session' },
        activeTabIdByWorktree: { [WORKSPACE]: LOCAL_TAB },
        tabBarOrderByWorktree: { [WORKSPACE]: [LOCAL_TAB] }
      })
      let surface = {
        conversationId: 'c',
        sourceSessionId: 'a',
        tabId: HOST_TAB,
        location: entrySnapshot.conversation.location,
        visible: true,
        surfaceRevision: 1,
        publishedRevision: 1
      }
      let version = 0
      function inventory(complete = true): RuntimeMobileSessionTabsResult {
        return {
          worktree: WORKSPACE,
          publicationEpoch: 'epoch',
          snapshotVersion: ++version,
          tabs:
            surface.visible && complete
              ? [
                  {
                    type: 'conversation',
                    id: HOST_TAB,
                    conversationId: 'c',
                    activeSessionId: 'a',
                    activeAgent: 'claude',
                    contextGeneration: 1,
                    activationFence: 1,
                    surfaceRevision: surface.surfaceRevision,
                    title: 'Conversation',
                    isActive: true
                  }
                ]
              : [],
          activeTabId: surface.visible ? HOST_TAB : null,
          activeGroupId: null,
          activeTabType: surface.visible ? 'conversation' : null,
          conversationSurfaces: complete
            ? { complete: true, surfaces: [surface] }
            : { complete: false, reason: 'unavailable' }
        }
      }
      const apply = (snapshot: RuntimeMobileSessionTabsResult) => {
        const state = store.getState()
        store.setState(
          kind === 'local'
            ? applyLocalStructuredSessionTabSnapshots(state, [snapshot], environmentId)
            : applyWebSessionTabsSnapshot(state, snapshot, environmentId)
        )
      }
      const refresh = async () => {
        if (!surface.visible && missingHideFrame) {
          throw new Error('Hide frame unavailable')
        }
        apply(inventory())
      }
      mocks.localRefresh.mockImplementation(refresh)
      mocks.remoteRefresh.mockImplementation(refresh)
      mocks.rpc.mockImplementation(async (actualTarget, method, params, options) => {
        expect(actualTarget).toEqual(target)
        expect(options.expectedEnvironmentPairingRevision).toBe(kind === 'remote' ? 10 : undefined)
        options.beforeSend?.()
        if (method === 'conversation.setSurfaceVisibility') {
          const request = ConversationSurfaceVisibilityParams.parse(params)
          expect(request.conversationId).toBe('c')
          expect(request.expectedSurfaceRevision).toBe(surface.surfaceRevision)
          surface = {
            ...surface,
            visible: request.visible,
            surfaceRevision: surface.surfaceRevision + 1,
            publishedRevision: surface.surfaceRevision + 1
          }
        } else {
          expect(method).toBe('conversation.surfaceRead')
        }
        return {
          ...entrySnapshot,
          operation: null,
          conversation: { ...entrySnapshot.conversation, pendingOperationKey: null },
          surface
        }
      })
      apply(inventory())
      expect(store.getState().unifiedTabsByWorktree[WORKSPACE]?.[0]).toMatchObject({
        id: LOCAL_TAB,
        contentType: 'conversation',
        entityId: 'c'
      })
      if (incomplete) {
        apply(inventory(false))
      }

      store.getState().closeUnifiedTab(LOCAL_TAB)
      await vi.waitFor(() => expect(surface.visible).toBe(false))
      await vi.waitFor(() => expect(isTabClosePending(LOCAL_TAB)).toBe(false))
      expect(store.getState().unifiedTabsByWorktree[WORKSPACE] ?? []).toEqual(
        missingHideFrame ? [expect.objectContaining({ id: LOCAL_TAB, entityId: 'c' })] : []
      )
      expect(store.getState().recentlyClosedConversationTabsByWorktree[WORKSPACE]).toHaveLength(1)

      if (foreignCanonical) {
        store.setState({
          unifiedTabsByWorktree: {
            [WORKSPACE]: [
              {
                ...source,
                id: HOST_TAB,
                contentType: 'conversation',
                entityId: 'c',
                executionHostId: 'runtime:other-host'
              }
            ]
          }
        })
      }
      expect(store.getState().reopenClosedTab(WORKSPACE)).toBe(true)
      await vi.waitFor(() => expect(surface.visible).toBe(true))
      await vi.waitFor(() =>
        expect(store.getState().unifiedTabsByWorktree[WORKSPACE]).toEqual([
          ...(foreignCanonical
            ? [expect.objectContaining({ id: HOST_TAB, executionHostId: 'runtime:other-host' })]
            : []),
          expect.objectContaining({ contentType: 'conversation', entityId: 'c', executionHostId })
        ])
      )
      const restored = store
        .getState()
        .unifiedTabsByWorktree[WORKSPACE]!.find((tab) => tab.executionHostId === executionHostId)!
      await vi.waitFor(() =>
        expect(
          store
            .getState()
            .groupsByWorktree[WORKSPACE]?.some((group) => group.activeTabId === restored.id)
        ).toBe(true)
      )
      expect(store.getState().recentlyClosedConversationTabsByWorktree[WORKSPACE]).toEqual([])
    }
  )
})
