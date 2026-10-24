import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { expect, it, vi } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

it('rechecks trusted admission inside the durable layout queue before changing the draft', async () => {
  const { store, authority, readState } = await fixture()
  const gate = authority.pause()
  const earlier = store.runDurableMutation(() => {
    store.updateSettings({ theme: 'dark' })
    return { value: undefined }
  })
  await gate.started.promise
  let admitted = true
  const check = vi.fn(() => {
    if (!admitted) {
      throw new Error('conversation capability required')
    }
  })
  const before = structuredClone(store.getWorkspaceSession())
  const pending = store.applyLayoutCommand(
    {
      type: 'openEditorTab',
      workspace: 'repo-local::/fixture/local',
      tabId: 'guarded-editor',
      fileId: '/a.ts',
      contentType: 'editor'
    },
    [],
    { beforeMutation: check }
  )
  const rejected = expect(pending).rejects.toThrow('conversation capability required')
  admitted = false
  gate.finish.resolve()
  await earlier
  await rejected
  expect(check).toHaveBeenCalledOnce()
  expect(store.getWorkspaceSession()).toEqual(before)
  expect(readState().workspaceSession).toEqual(before)
})

it('rechecks batched title admission after a preceding durable write', async () => {
  const { store, authority, readState } = await fixture()
  const gate = authority.pause()
  const earlier = store.runDurableMutation(() => {
    store.updateSettings({ theme: 'dark' })
    return { value: undefined }
  })
  await gate.started.promise
  let supported = true
  const before = structuredClone(store.getWorkspaceSession())
  const pending = store.applyTabRenames(
    [
      {
        hostId: 'local',
        renames: [
          {
            type: 'renameTab',
            workspace: 'wt',
            tabId: 'conversation-tab',
            kind: 'generated',
            title: 'Changed'
          }
        ]
      }
    ],
    () => {
      if (!supported) {
        throw new Error('conversation capability required')
      }
    }
  )
  const rejected = expect(pending).rejects.toThrow('conversation capability required')
  supported = false
  gate.finish.resolve()
  await earlier
  await rejected
  expect(store.getWorkspaceSession()).toEqual(before)
  expect(readState().workspaceSession).toEqual(before)
})

it('rechecks renderer terminal close inside the real durable queue before tombstones', async () => {
  const { store, authority, readState } = await fixture()
  const runtime = new OrcaRuntimeService(store)
  const gate = authority.pause()
  const earlier = store.runDurableMutation(() => {
    store.updateSettings({ theme: 'dark' })
    return { value: undefined }
  })
  await gate.started.promise
  let promoted = false
  const before = structuredClone(store.getWorkspaceSession())
  const check = vi.fn(() => {
    if (promoted) {
      throw new Error('conversation close requires visibility operation')
    }
  })
  const pending = runtime.closeTerminalSurfaceFromRenderer(
    {
      worktreeId: 'repo-local::/fixture/local',
      target: { kind: 'tab', tabId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d' },
      reason: 'user'
    },
    check
  )
  const rejected = expect(pending).rejects.toThrow(
    'conversation close requires visibility operation'
  )
  expect(check).not.toHaveBeenCalled()
  promoted = true
  gate.finish.resolve()
  await earlier
  await rejected
  expect(check).toHaveBeenCalledOnce()
  expect(store.getWorkspaceSession()).toEqual(before)
  expect(readState().workspaceSession).toEqual(before)
})
