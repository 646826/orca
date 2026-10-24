import type { ConversationTabSurface } from '../native-chat/conversations/conversation-tab-surface'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, listSurfaces, ownership } = vi.hoisted(() => ({
  ownership: { main: false },
  listSurfaces: vi.fn<() => readonly ConversationTabSurface[]>(() => []),
  handlers: new Map<string, (event: { returnValue?: unknown }, ...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(
      (
        channel: string,
        handler: (event: { returnValue?: unknown }, ...args: unknown[]) => unknown
      ) => {
        handlers.set(channel, handler)
      }
    ),
    on: vi.fn(
      (
        channel: string,
        handler: (event: { returnValue?: unknown }, ...args: unknown[]) => unknown
      ) => {
        handlers.set(channel, handler)
      }
    )
  }
}))

vi.mock('../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return ownership.main
  }
}))

import { getDefaultWorkspaceSession } from '../../shared/constants'
import { registerSessionHandlers } from './session'

describe.each([false, true])('registerSessionHandlers main owner %s', (main) => {
  beforeEach(() => {
    ownership.main = main
    listSurfaces.mockReset().mockReturnValue([])
  })
  it('drops renderer writes to a fenced host source partition and keeps every other one', async () => {
    const store = {
      getSshTarget: vi.fn((id: string) =>
        id === 'fenced' ? { orcadFence: { environmentId: 'env-1' } } : {}
      ),
      // Read by the switch-on save, which keeps main's own layout.
      getWorkspaceSession: vi.fn(() => getDefaultWorkspaceSession()),
      setWorkspaceSession: vi.fn(),
      patchWorkspaceSession: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => Promise.resolve())
    }
    registerSessionHandlers(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these set/patch handler fixtures implement the exercised store reads and writes; no other store method is called.
      store as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: set/patch only reads shutdown facts and awaits the supplied record-store surface inventory; no native runtime operation is exercised.
      {
        shutdownReconnectFactsFor: () => ({}),
        openAgentSessionRecordStore: async () => ({
          conversations: { surfaces: { list: listSurfaces } }
        })
      } as never
    )

    for (const hostId of ['ssh:fenced', 'ssh:open', undefined]) {
      await handlers.get('session:set')?.({}, {}, hostId)
      await handlers.get('session:patch')?.({}, {}, hostId)
    }
    expect(store.setWorkspaceSession.mock.calls.map(([, hostId]) => hostId)).toEqual([
      'ssh:open',
      undefined
    ])
    expect(store.patchWorkspaceSession.mock.calls.map(([, hostId]) => hostId)).toEqual([
      'ssh:open',
      undefined
    ])
  })
  it('waits for authoritative surface loading and refuses an omitted conversation before saving', async () => {
    const ready = Promise.withResolvers<void>()
    const store = {
      getSshTarget: () => undefined,
      getWorkspaceSession: () => getDefaultWorkspaceSession(),
      setWorkspaceSession: vi.fn(),
      patchWorkspaceSession: vi.fn()
    }
    listSurfaces.mockReturnValueOnce([
      {
        conversationId: 'conversation',
        sourceSessionId: 'source',
        tabId: 'tab',
        visible: true,
        location: {
          executionHostId: 'local',
          workspaceId: 'wt',
          workspaceKind: 'folder',
          wslDistro: null
        },
        surfaceRevision: 1,
        publishedRevision: 1
      }
    ])
    registerSessionHandlers(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these set/patch handler fixtures implement the exercised store reads and writes; no other store method is called.
      store as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: set/patch only reads shutdown facts and awaits the supplied record-store surface inventory; no native runtime operation is exercised.
      {
        shutdownReconnectFactsFor: () => ({}),
        openAgentSessionRecordStore: async () => {
          await ready.promise
          return { conversations: { surfaces: { list: listSurfaces } } }
        }
      } as never
    )
    const writing = Promise.resolve(handlers.get('session:set')!({}, getDefaultWorkspaceSession()))
    const rejected = expect(writing).rejects.toMatchObject({ reason: 'unsupported' })
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
    ready.resolve()
    await rejected
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
  })
  it('keeps a later view patch behind an earlier save waiting for record readiness', async () => {
    const ready = Promise.withResolvers<void>()
    const writes: string[] = []
    const store = {
      getSshTarget: () => undefined,
      getWorkspaceSession: () => getDefaultWorkspaceSession(),
      setWorkspaceSession: () => writes.push('set'),
      patchWorkspaceSession: () => writes.push('patch')
    }
    registerSessionHandlers(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these set/patch handler fixtures implement the exercised store reads and writes; no other store method is called.
      store as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: set/patch only reads shutdown facts and awaits the supplied record-store surface inventory; no native runtime operation is exercised.
      {
        shutdownReconnectFactsFor: () => ({}),
        openAgentSessionRecordStore: async () => {
          await ready.promise
          return { conversations: { surfaces: { list: () => [] } } }
        }
      } as never
    )
    const first = handlers.get('session:set')!({}, getDefaultWorkspaceSession())
    const second = handlers.get('session:patch')!({}, { activeTabId: 'view' })
    expect(writes).toEqual([])
    ready.resolve()
    await Promise.all([first, second])
    expect(writes).toEqual(['set', 'patch'])
  })
})
