import { expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { ConversationTabSurface } from '../native-chat/conversations/conversation-tab-surface'
import { withChatTabChanges } from './agent-session-tab-layout'
import { restoreConversationTabSurfaces } from './conversation-tab-restoration'
import { fixture } from '../persistence/loading-store/profile-state-delayed-authority-fixture'
const empty: WorkspaceSessionState = {
  activeRepoId: null,
  activeWorktreeId: null,
  activeTabId: null,
  tabsByWorktree: {},
  terminalLayoutsByTabId: {}
}
const surface: ConversationTabSurface = {
  conversationId: 'c',
  sourceSessionId: 'a',
  tabId: 'visual-a',
  location: {
    executionHostId: 'local',
    workspaceId: 'folder',
    workspaceKind: 'folder',
    wslDistro: null
  },
  visible: true,
  surfaceRevision: 1,
  publishedRevision: 0
}
it('replays promotion with same tab after publication crash and only acknowledges after flush', async () => {
  const { store } = await fixture()
  const session = withChatTabChanges('local', empty, 'folder', [
    { open: { sessionId: 'a', agent: 'codex', tabId: 'visual-a' } }
  ])!
  store.setWorkspaceSession(session)
  await store.flushPendingOrThrowAsync()
  const acknowledge = vi.fn(async () => surface)
  const flush = vi.fn(async () => {
    expect(acknowledge).not.toHaveBeenCalled()
    await store.flushPendingOrThrowAsync()
  })
  const ports = {
    hostId: 'local' as const,
    list: () => [surface],
    readSession: () => store.getWorkspaceSession(),
    applyLayoutCommand: store.applyLayoutCommand.bind(store),
    flush,
    acknowledge
  }
  await restoreConversationTabSurfaces(ports)
  expect(store.getWorkspaceSession().unifiedTabs?.folder?.[0]).toMatchObject({
    id: 'visual-a',
    entityId: 'c',
    contentType: 'conversation'
  })
  expect(acknowledge).toHaveBeenCalledWith({ conversationId: 'c', expectedSurfaceRevision: 1 })
  acknowledge.mockClear()
  await restoreConversationTabSurfaces(ports)
  expect(store.getWorkspaceSession().unifiedTabs?.folder).toHaveLength(1)
})
it('does not acknowledge failed flush or overwrite conflicting tab content', async () => {
  const { store } = await fixture()
  store.setWorkspaceSession(empty)
  await store.flushPendingOrThrowAsync()
  const acknowledge = vi.fn(async () => surface)
  const ports = {
    hostId: 'local' as const,
    list: () => [surface],
    readSession: () => store.getWorkspaceSession(),
    applyLayoutCommand: store.applyLayoutCommand.bind(store),
    flush: async () => {
      throw new Error('disk full')
    },
    acknowledge
  }
  await expect(restoreConversationTabSurfaces(ports)).rejects.toThrow('disk full')
  expect(acknowledge).not.toHaveBeenCalled()
  store.setWorkspaceSession(
    withChatTabChanges('local', empty, 'folder', [
      { open: { sessionId: 'foreign', agent: 'codex', tabId: 'visual-a' } }
    ])!
  )
  await expect(restoreConversationTabSurfaces(ports)).rejects.toThrow('scope-mismatch')
})
it('refuses publication acknowledgment for an existing conversation missing its visible group', async () => {
  const { acknowledgeConversationSurfacePublication } =
    await import('./conversation-tab-restoration')
  const session: WorkspaceSessionState = {
    ...empty,
    unifiedTabs: {
      folder: [
        {
          id: 'visual-a',
          entityId: 'c',
          contentType: 'conversation',
          worktreeId: 'folder',
          groupId: 'missing',
          label: 'Chat',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
  }
  const acknowledge = vi.fn(async () => surface)
  await expect(
    acknowledgeConversationSurfacePublication({
      hostId: 'local',
      list: () => [surface],
      readSession: () => session,
      flush: async () => {},
      acknowledge
    })
  ).rejects.toThrow()
  expect(acknowledge).not.toHaveBeenCalled()
})

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
