import { NATIVE_CONVERSATION_RUNTIME_CAPABILITY } from '../../../shared/conversation-runtime-capabilities'
import { beforeEach, expect, it, vi } from 'vitest'
import type { subscribeRuntimeEnvironment } from './runtime-environment-transport-routing'

const mocks = vi.hoisted(() => ({ handle: vi.fn(), on: vi.fn(), subscribe: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle, on: mocks.on } }))
vi.mock('../../../shared/runtime-environment-store', () => ({
  resolveEnvironment: () => ({ id: 'env', pairingRevision: 1, createdAt: 1, runtimeId: 'server' })
}))
vi.mock('./runtime-environment-transport-routing', () => ({
  subscribeRuntimeEnvironment: mocks.subscribe
}))
import {
  observeRemoteConversationStatus,
  readRemoteConversationInventory
} from './remote-conversation-layout-admission'
import {
  getRuntimeEnvironmentTransportGeneration,
  advanceRuntimeEnvironmentTransportGeneration
} from './runtime-environment-transport-generation'
import {
  registerRuntimeEnvironmentSubscriptionHandlers,
  type PendingRuntimeSubscription,
  type RetainedRemoteRuntimeSubscription
} from './runtime-environment-subscription-handlers'

type Callbacks = Parameters<typeof subscribeRuntimeEnvironment>[5]

const sender = {
  id: 1,
  isDestroyed: () => false,
  send: vi.fn(),
  once: vi.fn(),
  removeListener: vi.fn()
}
const recordLayoutFrame = vi.fn()
const census = {
  id: 'stream',
  ok: true as const,
  result: { type: 'snapshots', snapshots: [] },
  _meta: { runtimeId: 'server' }
}

async function open(method: string): Promise<Callbacks> {
  let callbacks: Callbacks | undefined
  mocks.subscribe.mockImplementationOnce(
    async (...parameters: Parameters<typeof subscribeRuntimeEnvironment>) => {
      callbacks = parameters[5]
      return { requestId: 'request', sendBinary: vi.fn(() => true), close: vi.fn() }
    }
  )
  const subscribe = mocks.handle.mock.calls.find(
    ([name]) => name === 'runtimeEnvironments:subscribe'
  )![1]
  await subscribe(
    { sender },
    { selector: 'env', method, subscriptionId: `${method}:${mocks.subscribe.mock.calls.length}` }
  )
  return callbacks!
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.subscribe.mockReset()
  registerRuntimeEnvironmentSubscriptionHandlers({
    getUserDataPath: () => '/profile',
    remoteRuntimeSubscriptions: new Map<string, RetainedRemoteRuntimeSubscription>(),
    pendingSubscriptions: new Map<string, PendingRuntimeSubscription>(),
    recordLayoutFrame
  })
})

it('records the window’s own stream after forwarding it unchanged, opening nothing new', async () => {
  const callbacks = await open('session.tabs.subscribeAll')
  callbacks.onEvent({ type: 'response', response: census })

  // The window's subscription is the only request the server sees.
  expect(mocks.subscribe).toHaveBeenCalledOnce()
  expect(mocks.subscribe.mock.calls[0]?.[2]).toBe('session.tabs.subscribeAll')
  expect(sender.send).toHaveBeenCalledExactlyOnceWith('runtimeEnvironments:subscriptionEvent', {
    subscriptionId: 'session.tabs.subscribeAll:0',
    type: 'response',
    response: census
  })
  expect(recordLayoutFrame).toHaveBeenCalledExactlyOnceWith(
    'env',
    'session.tabs.subscribeAll',
    census
  )
  expect(sender.send.mock.invocationCallOrder[0]).toBeLessThan(
    recordLayoutFrame.mock.invocationCallOrder[0]!
  )
})

it('offers the recorder only frames the window was sent', async () => {
  const callbacks = await open('session.tabs.subscribeAll')
  callbacks.onEvent({ type: 'binary', bytes: new Uint8Array([1]) })
  callbacks.onEvent({ type: 'error', code: 'lost', message: 'lost' })
  // A replaced transport's late frame reaches neither the window nor the snapshot.
  advanceRuntimeEnvironmentTransportGeneration('env')
  sender.send.mockClear()
  callbacks.onEvent({ type: 'response', response: census })
  expect(sender.send).not.toHaveBeenCalled()
  expect(recordLayoutFrame).not.toHaveBeenCalled()
})

const protectedCensus = {
  ...census,
  result: {
    type: 'snapshots',
    conversationSurfacesComplete: true,
    snapshots: [
      {
        worktree: 'folder',
        publicationEpoch: 'published',
        snapshotVersion: 1,
        conversationSurfaces: {
          complete: true,
          surfaces: [
            {
              conversationId: 'conversation',
              sourceSessionId: 'source',
              tabId: 'stable',
              surfaceRevision: 1,
              publishedRevision: 1,
              visible: false,
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
}
const authority = () =>
  readRemoteConversationInventory('env', getRuntimeEnvironmentTransportGeneration('env'))

it('uses the actual authenticated relay to protect hidden conversation bindings until stream end', async () => {
  const callbacks = await open('session.tabs.subscribeAll')
  callbacks.onEvent({ type: 'response', response: protectedCensus })
  expect(authority()).toMatchObject([
    { tabId: 'stable', visible: false, location: { executionHostId: 'runtime:env' } }
  ])
  callbacks.onEvent({ type: 'response', response: { ...census, result: { type: 'end' } } })
  expect(authority()).toBeNull()
  callbacks.onEvent({ type: 'response', response: protectedCensus })
  expect(authority()).toBeNull()
})

it('refuses a mismatched runtime identity and cannot revive authority after transport failure', async () => {
  const callbacks = await open('session.tabs.subscribeAll')
  callbacks.onEvent({
    type: 'response',
    response: { ...protectedCensus, _meta: { runtimeId: 'other' } }
  })
  expect(authority()).toBeNull()
  callbacks.onEvent({ type: 'response', response: protectedCensus })
  expect(authority()).toBeNull()
  const replacement = await open('session.tabs.subscribeAll')
  replacement.onEvent({ type: 'response', response: protectedCensus })
  expect(authority()).toHaveLength(1)
  replacement.onEvent({ type: 'error', code: 'lost', message: 'lost' })
  expect(authority()).toBeNull()
  replacement.onEvent({ type: 'response', response: protectedCensus })
  expect(authority()).toBeNull()
})

it.each(['checking', 'retired', 'capability-removed'] as const)(
  'requires a new authenticated census after %s status',
  async (mode) => {
    const callbacks = await open('session.tabs.subscribeAll')
    const complete = { ...census, result: { ...census.result, conversationSurfacesComplete: true } }
    callbacks.onEvent({ type: 'response', response: complete })
    const generation = getRuntimeEnvironmentTransportGeneration('env')
    expect(readRemoteConversationInventory('env', generation)).toEqual([])
    sender.send.mockClear()
    observeRemoteConversationStatus({
      environmentId: 'env',
      pairingRevision: 1,
      sequence: 2,
      checkedAt: 1,
      verification: mode === 'checking' ? 'checking' : 'verified',
      ...(mode === 'retired' ? { retired: true as const } : {}),
      transport: 'ready',
      status: {
        runtimeId: 'server',
        rendererGraphEpoch: 1,
        graphStatus: 'ready',
        authoritativeWindowId: null,
        liveTabCount: 0,
        liveLeafCount: 0,
        capabilities: mode === 'capability-removed' ? [] : [NATIVE_CONVERSATION_RUNTIME_CAPABILITY]
      }
    })
    callbacks.onEvent({ type: 'response', response: complete })
    expect(readRemoteConversationInventory('env', generation)).toBeNull()
    const replacement = await open('session.tabs.subscribeAll')
    replacement.onEvent({ type: 'response', response: complete })
    expect(readRemoteConversationInventory('env', generation)).toEqual([])
  }
)

it('closes the live renderer stream after epoch replacement so its normal retry requests a fresh census', async () => {
  const callbacks = await open('session.tabs.subscribeAll')
  callbacks.onEvent({ type: 'response', response: protectedCensus })
  sender.send.mockClear()
  callbacks.onEvent({
    type: 'response',
    response: {
      ...protectedCensus,
      result: {
        type: 'updated',
        ...protectedCensus.result.snapshots[0],
        publicationEpoch: 'replacement',
        snapshotVersion: 1
      }
    }
  })
  expect(authority()).toBeNull()
  expect(sender.send).toHaveBeenCalledWith(
    'runtimeEnvironments:subscriptionEvent',
    expect.objectContaining({ type: 'close' })
  )
  const replacement = await open('session.tabs.subscribeAll')
  replacement.onEvent({
    type: 'response',
    response: {
      ...protectedCensus,
      result: {
        ...protectedCensus.result,
        snapshots: [{ ...protectedCensus.result.snapshots[0], publicationEpoch: 'replacement' }]
      }
    }
  })
  expect(authority()).toHaveLength(1)
})

it('does not churn an ordinary old-host stream when its status has no conversation capability', async () => {
  await open('session.tabs.subscribeAll')
  sender.send.mockClear()
  observeRemoteConversationStatus({
    environmentId: 'env',
    pairingRevision: 1,
    sequence: 3,
    checkedAt: 2,
    verification: 'verified',
    transport: 'ready',
    status: null
  })
  expect(sender.send).not.toHaveBeenCalled()
})

it('keeps a pending census stream untrusted but live through an early status check', async () => {
  const callbacks = await open('session.tabs.subscribeAll')
  observeRemoteConversationStatus({
    environmentId: 'env',
    pairingRevision: 1,
    sequence: 4,
    checkedAt: 3,
    verification: 'checking',
    transport: 'ready',
    status: null
  })
  expect(authority()).toBeNull()
  callbacks.onEvent({ type: 'response', response: protectedCensus })
  expect(authority()).toHaveLength(1)
})
