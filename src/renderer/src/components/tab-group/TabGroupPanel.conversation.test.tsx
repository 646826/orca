// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import { ConversationSurfaceVisibilityParams } from '../../../../shared/conversation-surface-rpc'
import { entrySnapshot } from '../native-chat/native-chat-conversation-entry.test-fixture'
import { makeTab, makeUnifiedTab, makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import { applyLocalStructuredSessionTabSnapshots } from '@/runtime/local-structured-session-tabs-sync/snapshot-apply'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/snapshot-api'
import { resetLocalStructuredSessionVersionForTests } from '@/runtime/local-structured-session-tabs-sync/inventory-generation-fence'
import { resetWebSessionTabsSyncTestState } from '@/runtime/web-session-tabs-sync-test-harness'
import { structuredAgentSessionFocusOwner } from '@/runtime/structured-agent-session-owner'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import { RENAME_TERMINAL_TAB_EVENT } from '../tab-bar/terminal-tab-rename-request'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), refresh: vi.fn(), hostCall: vi.fn() }))
vi.mock('@/store', async () => ({
  useAppStore: (await import('@/store/slices/store-test-helpers')).createTestStore()
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClient>()),
  callRuntimeRpc: mocks.rpc
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: async () => ({ unsubscribe: () => {} })
}))
vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionWorktreeTabs: mocks.refresh
}))
vi.mock('@/runtime/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: mocks.refresh
}))
vi.mock('../editor/EditorPanel', () => ({
  default: () => <div data-testid="editor-panel">Editor</div>
}))
vi.mock('../tab-bar/TabBarQuickCommandsButton', () => ({
  TabBarQuickCommandsButton: () => null
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))

import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import TabGroupPanel from './TabGroupPanel'

const initialState = useAppStore.getState()
const WORKSPACE = 'w'
const GROUP = 'chat-group'
const SOURCE = 'source-pane'
const OTHER = 'other-pane'
const HOST = 'host-conversation-pane'

beforeEach(() => {
  useAppStore.setState(initialState, true)
  vi.clearAllMocks()
  mocks.hostCall.mockResolvedValue({ ok: true, result: {} })
  resetWebSessionTabsSyncTestState()
  resetLocalStructuredSessionVersionForTests()
  resetStructuredAgentSessionStatusFeedsForTests()
  replaceRuntimeEnvironmentRevisions([{ id: 'paired', createdAt: 10, pairingRevision: 10 }])
  vi.stubGlobal('api', {
    preflight: { detectAgents: async () => [] },
    runtimeEnvironments: { call: mocks.hostCall }
  })
})
afterEach(() => {
  cleanup()
  resetStructuredAgentSessionStatusFeedsForTests()
  vi.unstubAllGlobals()
})

describe.each(['local', 'remote'] as const)('%s conversation tab strip', (kind) => {
  it('keeps the promoted pane visible, selectable, and closable without mounting an editor', async () => {
    const target =
      kind === 'local'
        ? ({ kind: 'local' } as const)
        : ({ kind: 'environment', environmentId: 'paired' } as const)
    const executionHostId = kind === 'local' ? 'local' : 'runtime:paired'
    const environmentId = structuredAgentSessionFocusOwner(target).environmentId
    const source = makeUnifiedTab({
      id: SOURCE,
      worktreeId: WORKSPACE,
      groupId: GROUP,
      entityId: 'a',
      contentType: 'agent-session',
      agentSessionAgent: 'claude',
      executionHostId,
      label: 'Source chat'
    })
    useAppStore.setState({
      repos: [{ ...TEST_REPO, id: 'repo', path: '/w', executionHostId }],
      worktreesByRepo: {
        repo: [makeWorktree({ id: WORKSPACE, repoId: 'repo', path: '/w', hostId: executionHostId })]
      },
      unifiedTabsByWorktree: {
        [WORKSPACE]: [source, { ...source, id: OTHER, entityId: 'b', label: 'Other chat' }]
      },
      groupsByWorktree: {
        [WORKSPACE]: [
          { id: GROUP, worktreeId: WORKSPACE, tabOrder: [SOURCE, OTHER], activeTabId: SOURCE }
        ]
      },
      layoutByWorktree: { [WORKSPACE]: { type: 'leaf', groupId: GROUP } },
      activeWorktreeId: WORKSPACE,
      activeGroupIdByWorktree: { [WORKSPACE]: GROUP },
      activeTabIdByWorktree: { [WORKSPACE]: SOURCE },
      activeTabTypeByWorktree: { [WORKSPACE]: 'agent-session' },
      activeTabType: 'agent-session'
    })
    let surface = {
      conversationId: 'c',
      sourceSessionId: 'a',
      tabId: HOST,
      location: entrySnapshot.conversation.location,
      visible: true,
      surfaceRevision: 1,
      publishedRevision: 1
    }
    let version = 0
    const inventory = (): RuntimeMobileSessionTabsResult => ({
      worktree: WORKSPACE,
      publicationEpoch: 'epoch',
      snapshotVersion: ++version,
      activeTabId: HOST,
      activeGroupId: null,
      activeTabType: 'conversation',
      tabs: [
        ...(surface.visible
          ? [
              {
                type: 'conversation' as const,
                id: HOST,
                conversationId: 'c',
                activeSessionId: 'a',
                activeAgent: 'codex' as const,
                contextGeneration: 1,
                activationFence: 1,
                surfaceRevision: surface.surfaceRevision,
                title: 'Switched conversation',
                isActive: true
              }
            ]
          : []),
        {
          type: 'agent-session',
          id: 'agent-session:b',
          sessionId: 'b',
          agent: 'claude',
          title: 'Other chat',
          isActive: false
        }
      ],
      conversationSurfaces: { complete: true, surfaces: [surface] }
    })
    const apply = () => {
      const state = useAppStore.getState()
      useAppStore.setState(
        kind === 'local'
          ? applyLocalStructuredSessionTabSnapshots(state, [inventory()], environmentId)
          : applyWebSessionTabsSnapshot(state, inventory(), environmentId)
      )
    }
    mocks.refresh.mockImplementation(async () => apply())
    mocks.rpc.mockImplementation(async (actualTarget, method, params) => {
      if (method === 'session.tabs.activate') {
        expect(actualTarget).toEqual(target)
        expect(params.tabId).toBe(HOST)
        return undefined
      }
      if (method === 'conversation.setSurfaceVisibility') {
        const request = ConversationSurfaceVisibilityParams.parse(params)
        expect(actualTarget).toEqual(target)
        expect(request.conversationId).toBe('c')
        surface = {
          ...surface,
          visible: request.visible,
          surfaceRevision: surface.surfaceRevision + 1,
          publishedRevision: surface.surfaceRevision + 1
        }
      }
      if (method === 'conversation.surfaceRead' || method === 'conversation.setSurfaceVisibility') {
        return {
          ...entrySnapshot,
          operation: null,
          conversation: { ...entrySnapshot.conversation, pendingOperationKey: null },
          surface
        }
      }
      return undefined
    })
    const view = render(
      <TooltipProvider>
        <ConfirmationDialogProvider>
          <TabGroupPanel
            groupId={GROUP}
            worktreeId={WORKSPACE}
            isVisible
            isFocused
            hasSplitGroups={false}
            touchesLeftEdge
            touchesRightEdge
            reserveClosedExplorerToggleSpace={false}
            reserveCollapsedSidebarHeaderSpace={false}
          />
        </ConfirmationDialogProvider>
      </TooltipProvider>
    )
    const original = view.getByText('Source chat').closest('[data-tab-id]')
    expect(original?.getAttribute('data-active')).toBe('true')

    await act(async () => apply())
    const promoted = view.getByText('Switched conversation').closest('[data-tab-id]')
    expect(promoted).toBe(original)
    expect(promoted?.getAttribute('data-active')).toBe('true')
    expect(view.queryByTestId('editor-panel')).toBeNull()
    const collisionWorkspace = 'other-repo::/elsewhere'
    const collisionTab = makeUnifiedTab({
      id: 'unrelated-terminal',
      entityId: SOURCE,
      worktreeId: collisionWorkspace,
      groupId: 'other-group',
      contentType: 'terminal'
    })
    const collisionRuntime = makeTab({ id: SOURCE, worktreeId: collisionWorkspace })
    await act(async () => {
      useAppStore.setState((state) => ({
        unifiedTabsByWorktree: {
          ...state.unifiedTabsByWorktree,
          [collisionWorkspace]: [collisionTab]
        },
        tabsByWorktree: { [collisionWorkspace]: [collisionRuntime] }
      }))
    })
    fireEvent.doubleClick(promoted!)
    fireEvent(window, new CustomEvent(RENAME_TERMINAL_TAB_EVENT, { detail: { tabId: SOURCE } }))
    expect(view.queryByRole('textbox')).toBeNull()
    expect(view.getByText('Switched conversation').closest('[data-tab-id]')).toBe(promoted)
    expect(useAppStore.getState().unifiedTabsByWorktree[collisionWorkspace]).toEqual([collisionTab])
    expect(useAppStore.getState().tabsByWorktree[collisionWorkspace]).toEqual([collisionRuntime])
    await act(async () => useAppStore.getState().activateTab(OTHER))
    expect(promoted?.getAttribute('data-active')).toBe('false')
    fireEvent.pointerDown(promoted!, { button: 0, clientX: 1, clientY: 1 })
    fireEvent.pointerUp(window, { button: 0, clientX: 1, clientY: 1 })
    expect(promoted?.getAttribute('data-active')).toBe('true')
    expect(useAppStore.getState().groupsByWorktree[WORKSPACE]?.[0]?.activeTabId).toBe(SOURCE)
    expect(view.queryByTestId('editor-panel')).toBeNull()

    fireEvent.contextMenu(promoted!)
    expect(await view.findByRole('menuitem', { name: 'Copy Tab ID' })).not.toBeNull()
    for (const pinAction of view.queryAllByRole('menuitem', { name: /^(Pin|Unpin) Tab$/ })) {
      fireEvent.click(pinAction)
    }
    expect(useAppStore.getState().tabsByWorktree[collisionWorkspace]).toEqual([collisionRuntime])
    expect(view.queryByRole('menuitem', { name: /^(Pin|Unpin) Tab$/ })).toBeNull()
    fireEvent.keyDown(view.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(view.queryByRole('menu')).toBeNull())
    fireEvent.click(view.getByRole('button', { name: 'Close tab Switched conversation' }))
    await waitFor(() => expect(surface.visible).toBe(false))
    await waitFor(() => expect(view.queryByText('Switched conversation')).toBeNull())
    expect(view.getByText('Other chat')).not.toBeNull()
  })
})
