import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { Store } from '../persistence/loading-store/store'
import type { ConversationTabSurface } from '../native-chat/conversations/conversation-tab-surface'
import {
  emptyTerminalSessionProfile,
  FIXTURE_FOLDER_WORKTREE_ID,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStoreWithAuthority,
  reopenTopologyStore
} from '../persistence/terminal-topology/terminal-topology-profile-fixture'
import { withChatTabChanges } from './agent-session-tab-layout'
import { restoreConversationTabSurfaces } from './conversation-tab-restoration'

const ownership = vi.hoisted(() => ({ main: false }))
vi.mock('../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return ownership.main
  }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  vi.restoreAllMocks()
})

async function fixture(workspace = FIXTURE_FOLDER_WORKTREE_ID) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-conversation-layout-'))
  const opened = await openTopologyStoreWithAuthority(directory, emptyTerminalSessionProfile())
  let store = opened.store
  cleanups.push(async () => {
    await store.freezeWritesAsync()
    rmSync(directory, { recursive: true, force: true })
  })
  let surface: ConversationTabSurface = {
    conversationId: 'conversation',
    sourceSessionId: 'source',
    tabId: 'visual-chat',
    location: {
      executionHostId: 'local',
      workspaceId: workspace,
      workspaceKind: workspace === FIXTURE_FOLDER_WORKTREE_ID ? 'folder' : 'git-worktree',
      wslDistro: null
    },
    visible: true,
    surfaceRevision: 1,
    publishedRevision: 0
  }
  const initial = withChatTabChanges('local', getDefaultWorkspaceSession(), workspace, [
    { open: { sessionId: 'source', agent: 'codex', tabId: surface.tabId } },
    { open: { sessionId: 'ordinary', agent: 'claude', tabId: 'ordinary-chat' } }
  ])!
  store.setWorkspaceSession({
    ...initial,
    activeWorktreeId: workspace,
    activeTabId: surface.tabId,
    activeTabIdByWorktree: { [workspace]: surface.tabId },
    tabGroups: {
      ...initial.tabGroups,
      [workspace]: initial.tabGroups![workspace]!.map((group) => ({
        ...group,
        activeTabId: surface.tabId
      }))
    }
  })
  await store.flushPendingOrThrowAsync()
  const acknowledge = vi.fn(async () => undefined)
  return {
    get store() {
      return store
    },
    authority: opened.authority,
    workspace,
    acknowledge,
    setVisible(visible: boolean) {
      surface = { ...surface, visible, surfaceRevision: surface.surfaceRevision + 1 }
    },
    async reopen() {
      store = await reopenTopologyStore(store, directory)
      return store.getWorkspaceSession()
    },
    ports: {
      hostId: 'local' as const,
      list: () => [surface],
      readSession: () => store.getWorkspaceSession(),
      applyLayoutCommand: (...args: Parameters<Store['applyLayoutCommand']>) =>
        store.applyLayoutCommand(...args),
      flush: () => store.flushPendingOrThrowAsync(),
      acknowledge
    }
  }
}

describe.each([false, true])('durable conversation restoration, main owner %s', (main) => {
  beforeEach(() => {
    ownership.main = main
  })

  it.each([FIXTURE_FOLDER_WORKTREE_ID, FIXTURE_GIT_WORKTREE_ID])(
    'keeps placement and selection across promotion, cold restore and close/reopen in %s',
    async (workspace) => {
      const f = await fixture(workspace)
      const before = f.store.getWorkspaceSession()
      await restoreConversationTabSurfaces(f.ports)
      const promoted = await f.reopen()
      expect(promoted.tabGroups).toEqual(before.tabGroups)
      expect(promoted.activeTabId).toBe('visual-chat')
      expect(promoted.activeTabIdByWorktree).toEqual(before.activeTabIdByWorktree)
      expect(promoted.unifiedTabs?.[workspace]).toEqual([
        expect.objectContaining({
          id: 'visual-chat',
          entityId: 'conversation',
          contentType: 'conversation'
        }),
        expect.objectContaining({
          id: 'ordinary-chat',
          entityId: 'ordinary',
          contentType: 'agent-session'
        })
      ])
      await restoreConversationTabSurfaces(f.ports)
      expect(f.store.getWorkspaceSession()).toEqual(promoted)

      f.setVisible(false)
      await restoreConversationTabSurfaces(f.ports)
      const closed = await f.reopen()
      expect(closed.unifiedTabs?.[workspace]?.map((tab) => tab.id)).toEqual(['ordinary-chat'])
      expect(closed.tabGroups?.[workspace]?.flatMap((group) => group.tabOrder)).toEqual([
        'ordinary-chat'
      ])

      f.setVisible(true)
      await restoreConversationTabSurfaces(f.ports)
      const reopened = await f.reopen()
      expect(
        reopened.unifiedTabs?.[workspace]?.filter((tab) => tab.contentType === 'conversation')
      ).toEqual([expect.objectContaining({ id: 'visual-chat', entityId: 'conversation' })])
      expect(reopened.unifiedTabs?.[workspace]?.find((tab) => tab.id === 'ordinary-chat')).toEqual(
        closed.unifiedTabs?.[workspace]?.find((tab) => tab.id === 'ordinary-chat')
      )
    }
  )

  it('preserves an ordinary tab committed ahead of a queued promotion', async () => {
    const f = await fixture()
    const gate = f.authority.pause()
    const earlier = f.store.runDurableMutation(() => {
      f.store.updateSettings({ theme: 'dark' })
      return { value: undefined }
    })
    await gate.started.promise
    const editor = f.store.applyLayoutCommand({
      type: 'openEditorTab',
      workspace: f.workspace,
      tabId: 'editor',
      fileId: '/a.ts',
      contentType: 'editor'
    })
    const restoration = restoreConversationTabSurfaces(f.ports)
    gate.finish.resolve()
    await earlier
    expect((await editor).ok).toBe(true)
    await restoration
    const saved = await f.reopen()
    expect(saved.unifiedTabs?.[f.workspace]?.map((tab) => tab.id)).toEqual([
      'visual-chat',
      'ordinary-chat',
      'editor'
    ])
    expect(saved.unifiedTabs?.[f.workspace]?.[0]?.contentType).toBe('conversation')
  })

  it('refuses a queued close after the authoritative surface reopens', async () => {
    const f = await fixture()
    await restoreConversationTabSurfaces(f.ports)
    f.acknowledge.mockClear()
    f.setVisible(false)
    const gate = f.authority.pause()
    const earlier = f.store.runDurableMutation(() => {
      f.store.updateSettings({ theme: 'dark' })
      return { value: undefined }
    })
    await gate.started.promise
    const rejected = expect(restoreConversationTabSurfaces(f.ports)).rejects.toThrow(
      'stale-generation'
    )
    f.setVisible(true)
    gate.finish.resolve()
    await earlier
    await rejected
    expect(f.acknowledge).not.toHaveBeenCalled()
    expect((await f.reopen()).unifiedTabs?.[f.workspace]?.[0]).toMatchObject({
      id: 'visual-chat',
      contentType: 'conversation',
      entityId: 'conversation'
    })
  })

  it('does not close an ordinary tab rebound ahead of the queued surface close', async () => {
    const f = await fixture()
    await restoreConversationTabSurfaces(f.ports)
    f.acknowledge.mockClear()
    f.setVisible(false)
    const gate = f.authority.pause()
    const earlier = f.store.runDurableMutation(() => {
      f.store.updateSettings({ theme: 'dark' })
      return { value: undefined }
    })
    await gate.started.promise
    const close = f.store.applyLayoutCommand({
      type: 'closeTabs',
      workspace: f.workspace,
      tabIds: ['visual-chat'],
      force: true
    })
    const rebound = f.store.applyLayoutCommand({
      type: 'openAgentSessionTab',
      workspace: f.workspace,
      tabId: 'visual-chat',
      sessionId: 'foreign',
      agent: 'claude'
    })
    const rejected = expect(restoreConversationTabSurfaces(f.ports)).rejects.toThrow(
      'scope-mismatch'
    )
    gate.finish.resolve()
    await earlier
    expect((await close).ok).toBe(true)
    expect((await rebound).ok).toBe(true)
    await rejected
    expect(f.acknowledge).not.toHaveBeenCalled()
    expect(
      (await f.reopen()).unifiedTabs?.[f.workspace]?.find((tab) => tab.id === 'visual-chat')
    ).toMatchObject({
      contentType: 'agent-session',
      entityId: 'foreign'
    })
  })

  it('does not acknowledge a failed durable promotion, and retries without another tab', async () => {
    const f = await fixture()
    const before = f.store.getWorkspaceSession()
    f.authority.failNextWrite()
    await expect(restoreConversationTabSurfaces(f.ports)).rejects.toThrow(
      'profile_state_write_failed'
    )
    expect(f.acknowledge).not.toHaveBeenCalled()
    expect(f.store.getWorkspaceSession()).toEqual(before)
    await restoreConversationTabSurfaces(f.ports)
    expect((await f.reopen()).unifiedTabs?.[f.workspace]?.map((tab) => tab.id)).toEqual([
      'visual-chat',
      'ordinary-chat'
    ])
  })
})
