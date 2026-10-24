// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { Tab } from '../../../shared/tab-types'
import { createTestStore, makeWorktree, seedStore } from '@/store/slices/store-test-helpers'
import { activateStructuredAgentSessionTab } from './structured-agent-session-tab-activation'
import { getActiveTabNavOrder } from '@/components/tab-bar/group-tab-order'
import {
  handleSwitchTab,
  handleSwitchTabAcrossAllTypes,
  handleSwitchTerminalTab
} from '@/hooks/ipc-tab-switch'
import { useTerminalBulkCloseActions } from '@/components/use-terminal-bulk-close-actions'
import { setHostSessionTabIdMapping } from '@/runtime/web-session-tabs-sync/tracking-mappings'
import { resetWebSessionTabsSyncTestState } from '@/runtime/web-session-tabs-sync-test-harness'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '@/runtime/local-structured-session-owner'

const mocks = vi.hoisted(() => ({
  getState: vi.fn<() => AppState>(),
  rpc: vi.fn(async () => ({})),
  focusComposer: vi.fn(),
  visibility: vi.fn(),
  refresh: vi.fn(),
  retire: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: AppState) => unknown) => selector(mocks.getState()),
    {
      getState: mocks.getState,
      subscribe: () => () => {}
    }
  )
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/components/native-chat/use-native-chat-composer-reveal-focus', () => ({
  requestNativeChatComposerFocus: mocks.focusComposer
}))
vi.mock('@/runtime/conversation-tab-visibility', () => ({
  setConversationTabVisibility: mocks.visibility,
  refreshConversationTabLayout: mocks.refresh
}))
vi.mock('@/runtime/structured-agent-session-tab-retirement', () => ({
  beginStructuredAgentSessionTabClose: mocks.retire
}))
vi.mock('@/components/use-bulk-tab-close-confirmation', () => ({
  useBulkTabCloseConfirmation: () => vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))

const WT = 'conversation-workspace'
const GROUP = 'conversation-group'
const tab: Tab = {
  id: 'local-source-pane',
  entityId: 'aggregate-not-a-native-session',
  contentType: 'conversation',
  executionHostId: 'local',
  groupId: GROUP,
  worktreeId: WT,
  label: 'Conversation',
  customLabel: null,
  color: null,
  sortOrder: 1,
  createdAt: 1
}

function setup(executionHostId: Tab['executionHostId'] = 'local') {
  const store = createTestStore()
  const chats = [
    { ...tab, executionHostId },
    { ...tab, id: 'second-conversation-pane', entityId: 'second-aggregate', executionHostId }
  ]
  seedStore(store, {
    activeWorktreeId: WT,
    worktreesByRepo: {
      repo: [makeWorktree({ id: WT, repoId: 'repo', path: '/workspace', hostId: 'local' })]
    },
    unifiedTabsByWorktree: {
      [WT]: [
        { ...tab, id: 'terminal-pane', entityId: 'terminal-entity', contentType: 'terminal' },
        ...chats
      ]
    },
    groupsByWorktree: {
      [WT]: [
        {
          id: GROUP,
          worktreeId: WT,
          tabOrder: ['terminal-pane', ...chats.map((chat) => chat.id)],
          activeTabId: 'terminal-pane'
        }
      ]
    },
    activeGroupIdByWorktree: { [WT]: GROUP },
    tabBarOrderByWorktree: { [WT]: ['terminal-entity', ...chats.map((chat) => chat.id)] },
    activeTabId: 'terminal-entity',
    activeTabIdByWorktree: { [WT]: 'terminal-entity' },
    activeTabType: 'terminal'
  })
  mocks.getState.mockImplementation(() => store.getState())
  const environmentId = executionHostId === 'local' ? LOCAL_STRUCTURED_SESSION_OWNER : 'paired'
  for (const chat of chats) {
    setHostSessionTabIdMapping({ environmentId, worktreeId: WT, tabId: chat.id }, `host:${chat.id}`)
  }
  return store
}

beforeEach(() => {
  vi.clearAllMocks()
  resetWebSessionTabsSyncTestState()
})
afterEach(cleanup)

it.each(['local', 'runtime:paired'] as const)(
  'activates a conversation on its stamped owner %s using the mapped host tab',
  (owner) => {
    const store = setup(owner)
    expect(activateStructuredAgentSessionTab({ worktreeId: WT, tabId: tab.id })).toBe(true)
    expect(store.getState().getActiveTab(WT)).toMatchObject({
      id: tab.id,
      contentType: 'conversation'
    })
    expect(store.getState().activeTabType).toBe('conversation')
    expect(mocks.focusComposer).toHaveBeenCalledWith(tab.id)
    expect(mocks.rpc).toHaveBeenCalledWith(
      owner === 'local' ? { kind: 'local' } : { kind: 'environment', environmentId: 'paired' },
      'session.tabs.activate',
      expect.objectContaining({ tabId: `host:${tab.id}`, navigation: 'caller' })
    )
  }
)

it('cycles across and within conversation tabs without selecting aggregate IDs as editor files', () => {
  const store = setup()
  expect(handleSwitchTabAcrossAllTypes(1)).toBe(true)
  expect(store.getState().getActiveTab(WT)?.id).toBe(tab.id)
  expect(store.getState().activeTabType).toBe('conversation')
  expect(store.getState().activeFileId).toBeNull()
  expect(handleSwitchTab(1)).toBe(true)
  expect(store.getState().getActiveTab(WT)?.id).toBe('second-conversation-pane')
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    { kind: 'local' },
    'session.tabs.activate',
    expect.objectContaining({ tabId: 'host:second-conversation-pane' })
  )
})

it('includes conversations in the legacy no-group keyboard order with a distinct type', () => {
  const store = setup()
  store.setState({ groupsByWorktree: {}, activeGroupIdByWorktree: {} })
  expect(getActiveTabNavOrder(store.getState(), WT)).toEqual([
    { type: 'conversation', id: tab.entityId, tabId: tab.id },
    { type: 'conversation', id: 'second-aggregate', tabId: 'second-conversation-pane' }
  ])
})

it.each(['conversation', 'terminal'] as const)(
  'waits for group selection hydration rather than guessing a conversation target from %s',
  (activeTabType) => {
    const store = setup()
    store.setState({ groupsByWorktree: {}, activeGroupIdByWorktree: {}, activeTabType })
    expect(handleSwitchTab(1)).toBe(false)
    expect(handleSwitchTabAcrossAllTypes(1)).toBe(false)
    expect(store.getState().activeTabType).toBe(activeTabType)
    expect(store.getState().activeTabId).toBe('terminal-entity')
    expect(mocks.rpc).not.toHaveBeenCalled()
  }
)

it('refuses an explicit foreign activation target without changing the selected pane', () => {
  const store = setup('runtime:paired')
  expect(
    activateStructuredAgentSessionTab({ worktreeId: WT, tabId: tab.id, target: { kind: 'local' } })
  ).toBe(false)
  expect(store.getState().getActiveTab(WT)?.id).toBe('terminal-pane')
  expect(mocks.rpc).not.toHaveBeenCalled()
})

it('selects locally without guessing a host tab when only a foreign owner has a colliding mapping', () => {
  const store = setup('runtime:paired')
  resetWebSessionTabsSyncTestState()
  setHostSessionTabIdMapping(
    { environmentId: LOCAL_STRUCTURED_SESSION_OWNER, worktreeId: WT, tabId: tab.id },
    'unrelated-local-host-tab'
  )
  expect(activateStructuredAgentSessionTab({ worktreeId: WT, tabId: tab.id })).toBe(true)
  expect(store.getState().getActiveTab(WT)?.id).toBe(tab.id)
  expect(store.getState().activeTabType).toBe('conversation')
  expect(mocks.rpc).not.toHaveBeenCalled()
})

it('keeps the local conversation selected when its host refuses navigation', async () => {
  const store = setup()
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const refusal = new Error('conversation host unavailable')
  mocks.rpc.mockRejectedValueOnce(refusal)
  try {
    expect(activateStructuredAgentSessionTab({ worktreeId: WT, tabId: tab.id })).toBe(true)
    await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(expect.any(String), refusal))
    expect(store.getState().getActiveTab(WT)?.id).toBe(tab.id)
    expect(store.getState().activeTabType).toBe('conversation')
  } finally {
    warning.mockRestore()
  }
})

it('jumps from a conversation to the sole terminal instead of treating its stale terminal ID as active', () => {
  const store = setup()
  store.getState().activateTab(tab.id, { worktreeId: WT })
  store.getState().setActiveTabType('conversation', WT)
  expect(store.getState().activeTabId).toBe('terminal-entity')
  expect(handleSwitchTerminalTab(1)).toBe(true)
  expect(store.getState().activeTabType).toBe('terminal')
  expect(store.getState().getActiveTab(WT)?.id).toBe('terminal-pane')
})

it('bulk-closes only unpinned conversations through confirmed host visibility, never native retirement', async () => {
  const store = setup()
  store.setState({
    unifiedTabsByWorktree: {
      [WT]: [
        { ...tab },
        { ...tab, id: 'pinned-conversation', entityId: 'pinned-aggregate', isPinned: true }
      ]
    }
  })
  let confirm!: () => void
  mocks.visibility.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        confirm = resolve
      })
  )
  mocks.refresh.mockImplementationOnce(async () => {
    store.setState({
      unifiedTabsByWorktree: {
        [WT]: store.getState().unifiedTabsByWorktree[WT]!.filter((entry) => entry.id !== tab.id)
      }
    })
  })
  const { result } = renderHook(() =>
    useTerminalBulkCloseActions({
      activeWorktreeId: WT,
      closeBrowserTab: vi.fn(),
      closeFile: vi.fn(),
      closeTab: vi.fn(),
      queueEditorCloseRequests: vi.fn()
    })
  )
  act(() => result.current.closeTabBarTabs([tab.id, 'pinned-conversation']))
  expect(mocks.visibility).toHaveBeenCalledOnce()
  expect(store.getState().unifiedTabsByWorktree[WT]).toHaveLength(2)
  confirm()
  await vi.waitFor(() =>
    expect(store.getState().unifiedTabsByWorktree[WT]?.map((entry) => entry.id)).toEqual([
      'pinned-conversation'
    ])
  )
  expect(mocks.retire).not.toHaveBeenCalled()
})
