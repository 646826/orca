import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../loading-store/store'
import { fixture } from '../loading-store/profile-state-delayed-authority-fixture'
import { WindowSession } from './terminal-topology-window-session-fixture'

const ownership = vi.hoisted(() => ({ main: false }))
vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return ownership.main
  }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const workspace = 'repo-local::/fixture/local'
const remoteWorkspace = 'repo-remote::/fixture/remote'
const remoteHost = 'ssh:build-host'
const open = {
  type: 'openEditorTab',
  workspace,
  tabId: 'editor',
  fileId: '/a.ts',
  contentType: 'editor'
} as const
const rename = {
  type: 'renameTab',
  workspace,
  tabId: 'editor',
  kind: 'custom',
  title: 'Recovered'
} as const
const operations: {
  name: string
  apply: (store: Store, check: () => void, effects: () => void) => Promise<unknown>
}[] = [
  {
    name: 'command',
    apply: (store, beforeMutation, onEffects) =>
      store.applyLayoutCommand(rename, ['local'], { beforeMutation, onEffects })
  },
  {
    name: 'batched rename',
    apply: (store, check) => store.applyTabRenames([{ hostId: 'local', renames: [rename] }], check)
  },
  {
    name: 'cross-partition move',
    apply: (store, check) =>
      store.moveTabToWorkspaceAcrossPartitions(
        {
          type: 'moveTabToWorkspace',
          workspace,
          toWorkspace: remoteWorkspace,
          tabs: [{ tabId: 'editor', newTabId: 'editor', newEntityId: 'remote-editor' }],
          groupId: 'remote-group',
          file: { filePath: '/a.ts', relativePath: 'a.ts', language: 'typescript' }
        },
        'local',
        remoteHost,
        check
      )
  },
  {
    name: 'close',
    apply: (store, beforeMutation, onEffects) =>
      store.applyLayoutCommand(
        {
          type: 'closeTabs',
          workspace,
          tabIds: ['editor'],
          force: true
        },
        ['local'],
        { beforeMutation, onEffects }
      )
  }
]

describe.each([false, true])('layout admission recovery, main owner %s', (main) => {
  beforeEach(() => {
    ownership.main = main
  })

  it.each(operations)(
    'keeps persistence writable after a queued $name refusal',
    async (operation) => {
      const { store, authority, readState } = await fixture()
      await store.applyLayoutCommand(open)
      const before = structuredClone(store.getWorkspaceSession())
      const remoteBefore = structuredClone(store.getWorkspaceSession(remoteHost))
      const gate = authority.pause()
      const earlier = store.runDurableMutation(() => {
        store.updateSettings({ theme: 'dark' })
        return { value: undefined }
      })
      await gate.started.promise
      const writes = authority.captures.length
      const refusal = new Error('admission changed')
      const onEffects = vi.fn()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const operationEnded = vi.fn()
      const stop = store.onWorkspaceSessionOperationEnded(operationEnded)
      const rejected = expect(
        operation.apply(
          store,
          () => {
            throw refusal
          },
          onEffects
        )
      ).rejects.toBe(refusal)
      gate.finish.resolve()
      await earlier
      await rejected
      expect(store.getWorkspaceSession()).toEqual(before)
      expect(store.getWorkspaceSession(remoteHost)).toEqual(remoteBefore)
      expect(readState().workspaceSession).toEqual(before)
      expect(authority.captures).toHaveLength(writes)
      expect(onEffects).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
      expect(operationEnded.mock.calls.flat()).not.toContainEqual(['local'])
      stop()
      await expect(store.applyLayoutCommand(rename)).resolves.toEqual({ ok: true, result: {} })
      expect(
        readState().workspaceSession.unifiedTabs[workspace].find(
          (tab: { id: string }) => tab.id === 'editor'
        )
      ).toMatchObject({ customLabel: 'Recovered' })
    }
  )

  it('still poisons persistence when the admitted commit mutates and then throws', async () => {
    const { store, readState } = await fixture()
    const window = new WindowSession(store.getWorkspaceSession())
    window.addTab(workspace, 'bound-terminal', 'bound-leaf')
    window.bind('bound-terminal', 'bound-leaf', 'bound-pty')
    store.setWorkspaceSession(window.snapshot())
    await store.flushPendingOrThrowAsync()
    const saved = readState()
    const error = new Error('commit failed after changing state')
    const onEffects = vi.fn()
    await expect(
      store.applyLayoutCommand(
        {
          type: 'closeTabs',
          workspace,
          tabIds: ['bound-terminal'],
          force: true
        },
        ['local'],
        {
          beforeMutation: () => {},
          stopBeforeWrite: () => {
            store.updateSettings({ theme: saved.settings.theme === 'dark' ? 'light' : 'dark' })
            throw error
          },
          onEffects
        }
      )
    ).rejects.toBe(error)
    expect(store.getSettings().theme).not.toBe(saved.settings.theme)
    expect(readState().settings.theme).toBe(saved.settings.theme)
    expect(onEffects).not.toHaveBeenCalled()
    await expect(store.applyLayoutCommand(open)).rejects.toThrow('finalized')
    await expect(store.flushPendingOrThrowAsync()).rejects.toThrow('finalized')
  })
})

it('keeps an admitted close after a real disk failure and makes its retry durable', async () => {
  ownership.main = true
  const { store, authority, readState } = await fixture()
  await store.applyLayoutCommand(open)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const onEffects = vi.fn()
  authority.failNextWrite()
  await expect(
    store.applyLayoutCommand(
      {
        type: 'closeTabs',
        workspace,
        tabIds: ['editor'],
        force: true
      },
      ['local'],
      { beforeMutation: () => {}, onEffects }
    )
  ).resolves.toMatchObject({ ok: true })
  expect(
    store.getWorkspaceSession().unifiedTabs?.[workspace]?.some((tab) => tab.id === 'editor')
  ).toBe(false)
  expect(
    readState().workspaceSession.unifiedTabs[workspace].some(
      (tab: { id: string }) => tab.id === 'editor'
    )
  ).toBe(true)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('not yet saved'), expect.any(Error))
  expect(onEffects).toHaveBeenCalledOnce()
  await store.flushPendingOrThrowAsync()
  expect(
    readState().workspaceSession.unifiedTabs[workspace].some(
      (tab: { id: string }) => tab.id === 'editor'
    )
  ).toBe(false)
})
