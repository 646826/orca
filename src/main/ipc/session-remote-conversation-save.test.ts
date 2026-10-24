import { beforeEach, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { NATIVE_CONVERSATION_RUNTIME_CAPABILITY } from '../../shared/conversation-runtime-capabilities'
import { withChatTabChanges } from '../runtime/agent-session-tab-layout'
import { openRemoteConversationInventory } from './runtime-environments/remote-conversation-layout-admission'
import {
  getRuntimeEnvironmentTransportGeneration,
  advanceRuntimeEnvironmentTransportGeneration
} from './runtime-environments/runtime-environment-transport-generation'
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  close: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/synthetic-profile' },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler),
    on: vi.fn()
  }
}))
vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: () => ({ id: 'save-env', pairingRevision: 1, runtimeId: 'server' })
}))
vi.mock('./runtime-environments/runtime-environment-request-connections', () => ({
  getRuntimeEnvironmentStatusOwner: () => ({
    read: () => ({
      verification: 'verified',
      retired: false,
      pairingRevision: 1,
      status: { runtimeId: 'server', capabilities: [NATIVE_CONVERSATION_RUNTIME_CAPABILITY] }
    })
  })
}))
import { registerSessionHandlers } from './session'
function census() {
  const stream = openRemoteConversationInventory(
    'save-env',
    getRuntimeEnvironmentTransportGeneration('save-env'),
    'server'
  )
  stream.record(
    {
      id: 'inventory',
      ok: true,
      _meta: { runtimeId: 'server' },
      result: {
        type: 'snapshots',
        conversationSurfacesComplete: true,
        snapshots: [
          {
            worktree: 'folder',
            publicationEpoch: 'epoch',
            snapshotVersion: 1,
            conversationSurfaces: {
              complete: true,
              surfaces: [
                {
                  conversationId: 'conversation',
                  sourceSessionId: 'source',
                  tabId: 'protected',
                  visible: false,
                  surfaceRevision: 2,
                  publishedRevision: 2,
                  location: {
                    executionHostId: 'local',
                    workspaceId: 'folder',
                    workspaceKind: 'folder',
                    wslDistro: null
                  }
                }
              ]
            }
          }
        ]
      }
    },
    getRuntimeEnvironmentTransportGeneration('save-env')
  )
  return stream
}
function fixture(ready: Promise<void> = Promise.resolve()) {
  const save = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these session:set/patch tests use only the listed store methods; all inputs go through the real IPC handler.
  const store = {
    getWorkspaceSessionHostIds: () => ['runtime:save-env'],
    getSshTarget: () => undefined,
    getWorkspaceSession: getDefaultWorkspaceSession,
    setWorkspaceSession: save,
    patchWorkspaceSession: save
  } as never
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: record readiness is the only runtime call in set/patch; remote ownership is read through the actual authenticated inventory cache.
  const runtime = {
    closeTerminalSurfaceFromRenderer: mocks.close,
    shutdownReconnectFactsFor: () => ({}),
    openAgentSessionRecordStore: async () => {
      await ready
      return { conversations: { surfaces: { list: () => [] } } }
    }
  } as never
  registerSessionHandlers(store, runtime)
  return save
}
beforeEach(() => mocks.handlers.clear())
it('actual IPC refuses rebinding a hidden remote surface for full saves and layout patches', async () => {
  const save = fixture()
  const stream = census()
  try {
    const forged = withChatTabChanges('runtime:save-env', getDefaultWorkspaceSession(), 'folder', [
      { open: { sessionId: 'foreign', agent: 'codex', tabId: 'protected' } }
    ])!
    for (const method of ['session:set', 'session:patch']) {
      await expect(
        mocks.handlers.get(method)!({}, forged, 'runtime:save-env')
      ).rejects.toMatchObject({ reason: 'unsupported' })
    }
    expect(save).not.toHaveBeenCalled()
    await mocks.handlers.get('session:set')!({}, getDefaultWorkspaceSession(), 'runtime:save-env')
    expect(save).toHaveBeenCalledOnce()
  } finally {
    stream.close()
  }
})
it('checks remote census at final admission after readiness, while unrelated local saves still work', async () => {
  const ready = Promise.withResolvers<void>()
  const save = fixture(ready.promise)
  const stream = census()
  const pending = mocks.handlers.get('session:set')!(
    {},
    getDefaultWorkspaceSession(),
    'runtime:save-env'
  )
  const rejected = expect(pending).rejects.toMatchObject({ reason: 'unsupported' })
  advanceRuntimeEnvironmentTransportGeneration('save-env')
  ready.resolve()
  await rejected
  expect(save).not.toHaveBeenCalled()
  await mocks.handlers.get('session:set')!({}, getDefaultWorkspaceSession(), 'local')
  expect(save).toHaveBeenCalledOnce()
  stream.close()
})

it('refuses legacy terminal close of a hidden remote conversation without calling native close', async () => {
  fixture()
  const stream = census()
  mocks.close.mockClear()
  try {
    await expect(
      mocks.handlers.get('session:close-terminal-surface')!(
        {},
        {
          worktreeId: 'folder',
          target: { kind: 'tab', tabId: 'protected' },
          reason: 'user'
        }
      )
    ).rejects.toMatchObject({ reason: 'unsupported' })
    expect(mocks.close).not.toHaveBeenCalled()
  } finally {
    stream.close()
  }
})
