import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), subscribe: vi.fn() }))
vi.mock('./runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('./runtime-rpc-subscribe', () => ({ subscribeRuntimeRpc: mocks.subscribe }))
vi.mock('./runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: () => () => {}
}))
import { createRuntimeConversationReader } from './runtime-conversation-reader'
it('refuses a history response for another segment despite a matching revision', async () => {
  mocks.rpc.mockResolvedValue({
    segmentId: 'foreign',
    sourceRevision: 'r',
    readOnly: true,
    items: [],
    next: null,
    status: 'complete'
  })
  await expect(
    createRuntimeConversationReader({ kind: 'local' }, 'c').history(
      'expected',
      'r',
      null,
      new AbortController().signal
    )
  ).rejects.toThrow('scope changed')
})
it('explicitly unwatches a late ready event after local subscription disposal', async () => {
  let event!: (value: unknown) => void
  const unsubscribe = vi.fn()
  mocks.subscribe.mockImplementation(async (_target, _method, _params, callbacks) => {
    event = callbacks.onEvent
    return { unsubscribe }
  })
  mocks.rpc.mockResolvedValue({})
  const change = vi.fn()
  const close = await createRuntimeConversationReader({ kind: 'local' }, 'c').watch(change, vi.fn())
  close()
  event({
    type: 'ready',
    subscriptionId: 'late',
    state: {
      conversationId: 'c',
      revision: 1,
      contextGeneration: 1,
      activationFence: 1,
      activeSegmentId: 'a',
      pendingOperationKey: null,
      surfaceRevision: 1,
      historyInvalidated: false
    }
  })
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(change).not.toHaveBeenCalled()
  expect(mocks.rpc).toHaveBeenCalledWith(
    { kind: 'local' },
    'conversation.unwatch',
    {
      subscriptionId: 'late'
    },
    expect.objectContaining({ expectedEnvironmentPairingRevision: undefined })
  )
})
it('fences all requests and drops a late history response after the same host alias is re-paired', async () => {
  const { replaceRuntimeEnvironmentRevisions } = await import('./runtime-environment-revision')
  replaceRuntimeEnvironmentRevisions([{ id: 'paired', createdAt: 1 }])
  const reader = createRuntimeConversationReader(
    { kind: 'environment', environmentId: 'paired' },
    'c'
  )
  let resolve!: (value: unknown) => void
  mocks.rpc.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const result = reader.history('s', 'r', null, new AbortController().signal)
  replaceRuntimeEnvironmentRevisions([{ id: 'paired', createdAt: 2 }], {
    retired: ['paired'],
    sameHost: []
  })
  resolve({
    segmentId: 's',
    sourceRevision: 'r',
    readOnly: true,
    items: [],
    next: null,
    status: 'complete'
  })
  await expect(result).rejects.toThrow('owner changed')
  mocks.rpc.mockClear()
  await expect(reader.snapshot(new AbortController().signal)).rejects.toThrow('owner changed')
  expect(mocks.rpc).not.toHaveBeenCalled()
})
it('clears the subscribed owner on re-pair and never sends old unwatch to the replacement', async () => {
  const { replaceRuntimeEnvironmentRevisions } = await import('./runtime-environment-revision')
  replaceRuntimeEnvironmentRevisions([{ id: 'paired', createdAt: 3 }])
  mocks.subscribe.mockResolvedValue({ unsubscribe: vi.fn() })
  const lost = vi.fn()
  const reader = createRuntimeConversationReader(
    { kind: 'environment', environmentId: 'paired' },
    'c'
  )
  const close = await reader.watch(vi.fn(), vi.fn(), lost)
  expect(mocks.subscribe).toHaveBeenLastCalledWith(
    expect.anything(),
    'conversation.watch',
    expect.anything(),
    expect.anything(),
    { expectedEnvironmentPairingRevision: 3 }
  )
  replaceRuntimeEnvironmentRevisions([{ id: 'paired', createdAt: 4 }], {
    retired: ['paired'],
    sameHost: []
  })
  expect(lost).toHaveBeenCalledOnce()
  close()
})
