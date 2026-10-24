import { expect, it, vi, beforeEach } from 'vitest'
import type { Tab } from '../../../../../shared/tab-types'
const mocks = vi.hoisted(() => ({ visibility: vi.fn(), refresh: vi.fn(), retire: vi.fn() }))
vi.mock('@/runtime/conversation-tab-visibility', () => ({
  setConversationTabVisibility: mocks.visibility,
  refreshConversationTabLayout: mocks.refresh
}))
vi.mock('@/runtime/structured-agent-session-tab-retirement', () => ({
  beginStructuredAgentSessionTabClose: mocks.retire
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))
import { createTestStore, seedStore, makeWorktree } from '../store-test-helpers'
const tab: Tab = {
  id: 'same-tab',
  entityId: 'conversation',
  contentType: 'conversation',
  worktreeId: 'w',
  groupId: 'g',
  label: 'Conversation',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1,
  executionHostId: 'local'
}
function setup() {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo: [makeWorktree({ id: 'w', repoId: 'repo', path: '/w', hostId: 'local' })]
    },
    unifiedTabsByWorktree: { w: [tab] },
    groupsByWorktree: { w: [{ id: 'g', worktreeId: 'w', tabOrder: [tab.id], activeTabId: tab.id }] }
  })
  return store
}
beforeEach(() => {
  mocks.visibility.mockReset()
  mocks.refresh.mockReset()
  mocks.retire.mockReset()
})
it('keeps a conversation tab until authoritative hide and reopens the same identity without native retirement', async () => {
  const store = setup()
  let finish!: () => void
  mocks.visibility.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  mocks.refresh.mockImplementationOnce(async () => {
    store.setState({ unifiedTabsByWorktree: { w: [] } })
  })
  store.getState().closeUnifiedTab(tab.id)
  expect(store.getState().unifiedTabsByWorktree.w).toMatchObject([tab])
  expect(mocks.visibility).toHaveBeenCalledWith(
    expect.objectContaining({
      conversationId: 'conversation',
      tabId: 'same-tab',
      target: { kind: 'local' }
    }),
    false,
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  )
  finish()
  await vi.waitFor(() => expect(store.getState().unifiedTabsByWorktree.w).toEqual([]))
  mocks.visibility.mockResolvedValueOnce(undefined)
  mocks.refresh.mockImplementationOnce(async () => {
    store.setState({ unifiedTabsByWorktree: { w: [tab] } })
  })
  expect(store.getState().reopenClosedTab('w')).toBe(true)
  await vi.waitFor(() => expect(store.getState().unifiedTabsByWorktree.w).toMatchObject([tab]))
  expect(mocks.visibility).toHaveBeenLastCalledWith(
    expect.objectContaining({ conversationId: 'conversation', tabId: 'same-tab' }),
    true,
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  )
  expect(mocks.retire).not.toHaveBeenCalled()
})
it('does not remove the tab or record a successful close when the host outcome remains unknown', async () => {
  const store = setup()
  mocks.visibility.mockRejectedValue(new Error('Unknown close outcome'))
  store.getState().closeUnifiedTab(tab.id)
  await vi.waitFor(() => expect(mocks.visibility).toHaveBeenCalledOnce())
  await Promise.resolve()
  expect(store.getState().unifiedTabsByWorktree.w).toMatchObject([tab])
  expect(store.getState().recentlyClosedTabKindsByWorktree.w ?? []).toEqual([])
  expect(mocks.refresh).not.toHaveBeenCalled()
  expect(mocks.retire).not.toHaveBeenCalled()
})

it('keeps a failed reopen available for explicit retry and sends no native mutation', async () => {
  const store = setup()
  store.getState().rememberClosedConversationTab({
    conversationId: 'conversation',
    tabId: tab.id,
    workspaceId: 'w',
    target: { kind: 'local' }
  })
  mocks.visibility.mockRejectedValue(new Error('Disconnected'))
  expect(store.getState().reopenClosedTab('w')).toBe(true)
  await vi.waitFor(() =>
    expect(store.getState().recentlyClosedTabKindsByWorktree.w).toEqual(['conversation'])
  )
  expect(store.getState().recentlyClosedConversationTabsByWorktree.w).toHaveLength(1)
  expect(mocks.retire).not.toHaveBeenCalled()
})
it('captures a paired host and deduplicates rapid close requests', async () => {
  const store = setup(),
    remote = { ...tab, executionHostId: 'runtime:paired' as const }
  store.setState({
    worktreesByRepo: {
      repo: [makeWorktree({ id: 'w', repoId: 'repo', path: '/w', hostId: 'runtime:paired' })]
    },
    unifiedTabsByWorktree: { w: [remote] }
  })
  let reject!: (error: Error) => void
  mocks.visibility.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail
      })
  )
  store.getState().closeUnifiedTab(tab.id)
  store.getState().closeUnifiedTab(tab.id)
  expect(mocks.visibility).toHaveBeenCalledTimes(1)
  expect(mocks.visibility).toHaveBeenCalledWith(
    expect.objectContaining({ target: { kind: 'environment', environmentId: 'paired' } }),
    false,
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  )
  reject(new Error('Disconnected'))
  await Promise.resolve()
  await Promise.resolve()
  expect(store.getState().unifiedTabsByWorktree.w).toMatchObject([remote])
})
it('keeps a confirmed hidden view recoverable when the layout refresh fails', async () => {
  const store = setup()
  mocks.visibility.mockResolvedValue(undefined)
  mocks.refresh.mockRejectedValue(new Error('Frame unavailable'))
  store.getState().closeUnifiedTab(tab.id)
  await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce())
  expect(store.getState().unifiedTabsByWorktree.w).toMatchObject([tab])
  expect(store.getState().recentlyClosedConversationTabsByWorktree.w).toHaveLength(1)
  expect(mocks.retire).not.toHaveBeenCalled()
})
it('retains explicit reopen retry when the published frame does not contain the same aggregate', async () => {
  const store = setup()
  store.setState({ unifiedTabsByWorktree: { w: [] } })
  store.getState().rememberClosedConversationTab({
    conversationId: 'conversation',
    tabId: tab.id,
    workspaceId: 'w',
    target: { kind: 'local' }
  })
  mocks.visibility.mockResolvedValue(undefined)
  mocks.refresh.mockResolvedValue(undefined)
  store.getState().reopenClosedTab('w')
  await vi.waitFor(() =>
    expect(store.getState().recentlyClosedConversationTabsByWorktree.w).toHaveLength(1)
  )
  expect(store.getState().unifiedTabsByWorktree.w).toEqual([])
})
it('does not repopulate close history after confirmed teardown and same-ID recreation', async () => {
  const { deleteWorkspaceChatDrafts } =
    await import('../worktrees/teardown/removed-worktree-chat-drafts')
  const store = setup()
  let finish!: () => void
  mocks.visibility.mockImplementation(
    () =>
      new Promise<void>((done) => {
        finish = done
      })
  )
  store.getState().closeUnifiedTab(tab.id)
  deleteWorkspaceChatDrafts({
    owners: [{ workspaceId: 'w', executionHostId: 'local' }],
    conversations: [],
    terminalTabIds: []
  })
  store.setState({
    recentlyClosedConversationTabsByWorktree: {},
    recentlyClosedTabKindsByWorktree: {},
    unifiedTabsByWorktree: { w: [{ ...tab, entityId: 'replacement' }] }
  })
  finish()
  await Promise.resolve()
  await Promise.resolve()
  expect(store.getState().recentlyClosedConversationTabsByWorktree).toEqual({})
  expect(mocks.refresh).not.toHaveBeenCalled()
})
it('does not restore a failed reopen reference after workspace teardown', async () => {
  const { deleteWorkspaceChatDrafts } =
    await import('../worktrees/teardown/removed-worktree-chat-drafts')
  const store = setup()
  store.getState().rememberClosedConversationTab({
    conversationId: 'conversation',
    tabId: tab.id,
    workspaceId: 'w',
    target: { kind: 'local' }
  })
  let reject!: (error: Error) => void
  mocks.visibility.mockImplementation(
    () =>
      new Promise((_done, fail) => {
        reject = fail
      })
  )
  store.getState().reopenClosedTab('w')
  deleteWorkspaceChatDrafts({
    owners: [{ workspaceId: 'w', executionHostId: 'local' }],
    conversations: [],
    terminalTabIds: []
  })
  store.setState({
    recentlyClosedConversationTabsByWorktree: {},
    recentlyClosedTabKindsByWorktree: {}
  })
  reject(new Error('Reply lost'))
  await Promise.resolve()
  await Promise.resolve()
  expect(store.getState().recentlyClosedConversationTabsByWorktree).toEqual({})
  expect(store.getState().recentlyClosedTabKindsByWorktree).toEqual({})
})
it('does not cancel a local close when only another host owning the same workspace ID is removed', async () => {
  const { deleteWorkspaceChatDrafts } =
    await import('../worktrees/teardown/removed-worktree-chat-drafts')
  const store = setup()
  let finish!: () => void
  mocks.visibility.mockImplementation(
    () =>
      new Promise<void>((done) => {
        finish = done
      })
  )
  mocks.refresh.mockImplementation(async () => {
    store.setState({ unifiedTabsByWorktree: { w: [] } })
  })
  store.getState().closeUnifiedTab(tab.id)
  deleteWorkspaceChatDrafts({
    owners: [{ workspaceId: 'w', executionHostId: 'runtime:other' }],
    conversations: [],
    terminalTabIds: []
  })
  finish()
  await vi.waitFor(() =>
    expect(store.getState().recentlyClosedConversationTabsByWorktree.w).toHaveLength(1)
  )
  expect(mocks.refresh).toHaveBeenCalledOnce()
})
it('blocks a deferred frame and focus after owner teardown during refresh', async () => {
  const { deleteWorkspaceChatDrafts } =
    await import('../worktrees/teardown/removed-worktree-chat-drafts')
  const store = setup()
  mocks.visibility.mockResolvedValue(undefined)
  let release!: () => void
  const applied = vi.fn()
  mocks.refresh.mockImplementation(async (_ref, lifetime) => {
    await new Promise<void>((done) => {
      release = done
    })
    lifetime.assertCurrent()
    applied()
  })
  store.getState().closeUnifiedTab(tab.id)
  await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce())
  deleteWorkspaceChatDrafts({
    owners: [{ workspaceId: 'w', executionHostId: 'local' }],
    conversations: [],
    terminalTabIds: []
  })
  store.setState({
    recentlyClosedConversationTabsByWorktree: {},
    recentlyClosedTabKindsByWorktree: {},
    unifiedTabsByWorktree: { w: [] }
  })
  release()
  await Promise.resolve()
  await Promise.resolve()
  expect(applied).not.toHaveBeenCalled()
  expect(store.getState().recentlyClosedConversationTabsByWorktree).toEqual({})
})
it('retains an explicit reopen retry after a same-pairing connection generation changes', async () => {
  const { setRuntimeEnvironmentConnectionGenerationForTests } = await import('../runtime-status')
  const { replaceRuntimeEnvironmentRevisions } =
    await import('@/runtime/runtime-environment-revision')
  const store = setup()
  store.setState({
    worktreesByRepo: {
      repo: [makeWorktree({ id: 'w', repoId: 'repo', path: '/w', hostId: 'runtime:reconnect' })]
    }
  })
  replaceRuntimeEnvironmentRevisions([{ id: 'reconnect', createdAt: 10 }])
  setRuntimeEnvironmentConnectionGenerationForTests('reconnect', 1)
  store.getState().rememberClosedConversationTab({
    conversationId: 'conversation',
    tabId: tab.id,
    workspaceId: 'w',
    target: { kind: 'environment', environmentId: 'reconnect' },
    pairingRevision: 10
  })
  let reject!: (error: Error) => void
  mocks.visibility.mockImplementation(
    () =>
      new Promise((_done, fail) => {
        reject = fail
      })
  )
  store.getState().reopenClosedTab('w')
  setRuntimeEnvironmentConnectionGenerationForTests('reconnect', 2)
  reject(new Error('Connection replaced'))
  await Promise.resolve()
  await Promise.resolve()
  expect(store.getState().recentlyClosedConversationTabsByWorktree.w).toHaveLength(1)
  expect(mocks.refresh).not.toHaveBeenCalled()
})
