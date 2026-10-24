import { expect, it, vi } from 'vitest'
import {
  attach,
  hostTestState,
  CALLER,
  seedApproval,
  envelope
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION,
  HOST_TEST_NOW,
  hostTestOperationId,
  hostTestMessage
} from './structured-agent-session-host-test-data'

async function beginClear() {
  await attach()
  const { host, store } = hostTestState()
  host.deps.hasOpenDispatch = () => false
  const conversation = await store.conversations.ensureSingleton(HOST_TEST_SESSION)
  const begun = await store.conversations.clear.begin(
    {
      conversationId: conversation.conversationId,
      expectedRevision: conversation.revision,
      expectedContextGeneration: conversation.contextGeneration,
      expectedActivationFence: conversation.activationFence
    },
    {
      callerKey: CALLER.callerKey,
      operationId: hostTestOperationId(),
      fingerprint: 'clear',
      now: HOST_TEST_NOW
    }
  )
  if (!begun.intent) {
    throw new Error('missing clear intent')
  }
  return { host, store, intent: begun.intent }
}

it('clears through the real host and commits one new generation without acquiring a provider', async () => {
  const { host, store, intent } = await beginClear()
  const { acquire, dispatch } = hostTestState()
  const acquisitions = acquire.mock.calls.length
  expect(
    await host.advanceConversationClear(intent.operationKey, new AbortController().signal)
  ).toEqual({ kind: 'committed' })
  expect(store.conversations.read(intent.conversationId)).toMatchObject({
    contextGeneration: 2,
    pendingOperationKey: null
  })
  expect(store.getRecord(HOST_TEST_SESSION)?.providerHandleChain).toEqual([])
  expect(acquire).toHaveBeenCalledTimes(acquisitions)
  expect(dispatch).not.toHaveBeenCalled()
  expect(
    await host.advanceConversationClear(intent.operationKey, new AbortController().signal)
  ).toEqual({ kind: 'committed' })
})

it('keeps the production serializer available while native exit is pending', async () => {
  const { host, intent } = await beginClear()
  const exit = Promise.withResolvers<void>()
  const entered = vi.fn()
  host.deps.adapter.disposeSession = async () => {
    entered()
    await exit.promise
    return true
  }
  const advancing = host.advanceConversationClear(intent.operationKey, new AbortController().signal)
  try {
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
    const settled = vi.fn()
    void host.collaboratorsForTests().serialize(HOST_TEST_SESSION, async () => {
      settled()
    })
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce())
  } finally {
    exit.resolve()
  }
  expect(await advancing).toEqual({ kind: 'committed' })
})

it('refuses pending approvals without stopping the provider or clearing evidence', async () => {
  const { host, store, intent } = await beginClear()
  await seedApproval()
  const stop = vi.fn(async () => true)
  host.deps.adapter.disposeSession = stop
  expect(
    await host.advanceConversationClear(intent.operationKey, new AbortController().signal)
  ).toMatchObject({ kind: 'blocked', reasons: expect.arrayContaining(['pending-prompts']) })
  expect(store.conversations.read(intent.conversationId)?.contextGeneration).toBe(1)
  expect(stop).not.toHaveBeenCalled()
})

it('refuses native-only clear and command-bearing sends on an enrolled idle aggregate', async () => {
  await attach()
  const { host, store, dispatch } = hostTestState()
  await store.conversations.ensureSingleton(HOST_TEST_SESSION)
  const command = await host.conversationCommand(CALLER, {
    command: 'clear',
    envelope: envelope('agentSession.conversationCommand', { command: 'clear' })
  })
  expect(command).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'conversationClearRequired' } }
  })
  const body = { ...hostTestMessage('/clear'), command: { name: 'clear' } }
  const send = await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  expect(send).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'conversationClearRequired' } }
  })
  expect(dispatch).not.toHaveBeenCalled()
})

it('persists unproven native shutdown and reconciles proof before advancing the generation', async () => {
  const { host, store, intent } = await beginClear()
  const stop = vi.fn(async () => false)
  host.deps.adapter.disposeSession = stop
  expect(
    await host.advanceConversationClear(intent.operationKey, new AbortController().signal)
  ).toEqual({ kind: 'reconciliation-required' })
  expect(store.conversations.clear.intent(intent.operationKey)?.phase).toBe(
    'reconciliation-required'
  )
  expect(store.conversations.read(intent.conversationId)?.contextGeneration).toBe(1)
  stop.mockResolvedValue(true)
  expect(
    await host.advanceConversationClear(intent.operationKey, new AbortController().signal)
  ).toEqual({ kind: 'committed' })
  expect(store.conversations.read(intent.conversationId)?.contextGeneration).toBe(2)
})

it('does not let a replacement clear adopt an earlier operation’s pending native stop', async () => {
  const { host, store, intent } = await beginClear()
  const exit = Promise.withResolvers<boolean>()
  const stop = vi.fn(() => exit.promise)
  host.deps.adapter.disposeSession = stop
  const advancing = host.advanceConversationClear(intent.operationKey, new AbortController().signal)
  const outcome = advancing.catch((error) => error)
  try {
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce())
    await store.conversations.clear.cancel({
      operationKey: intent.operationKey,
      expectedVersion: intent.version
    })
    const conversation = store.conversations.read(intent.conversationId)!
    const next = await store.conversations.clear.begin(
      {
        conversationId: intent.conversationId,
        expectedRevision: conversation.revision,
        expectedContextGeneration: conversation.contextGeneration,
        expectedActivationFence: conversation.activationFence
      },
      {
        callerKey: CALLER.callerKey,
        operationId: hostTestOperationId(),
        fingerprint: 'replacement-clear',
        now: HOST_TEST_NOW
      }
    )
    if (!next.intent) {
      throw new Error('missing replacement clear')
    }
    expect(
      await host.advanceConversationClear(next.intent.operationKey, new AbortController().signal)
    ).toMatchObject({ kind: 'blocked', reasons: expect.arrayContaining(['stopping']) })
  } finally {
    exit.resolve(true)
  }
  expect(await outcome).toMatchObject({ message: 'stale-generation' })
  expect(store.conversations.read(intent.conversationId)?.contextGeneration).toBe(1)
})

it('rechecks known ownership at the final prepare transaction after native shutdown', async () => {
  const { host, store, intent } = await beginClear()
  let lateWriter = false
  host.deps.hasOpenDispatch = () => lateWriter
  host.deps.adapter.disposeSession = async () => {
    lateWriter = true
    return true
  }
  expect(
    await host.advanceConversationClear(intent.operationKey, new AbortController().signal)
  ).toMatchObject({ kind: 'blocked', reasons: expect.arrayContaining(['supervised-work']) })
  expect(store.conversations.read(intent.conversationId)?.contextGeneration).toBe(1)
})

it('rechecks known ownership in the fatal clear receipt after preparation', async () => {
  const { host, store, intent } = await beginClear()
  let lateWriter = false
  host.deps.hasOpenDispatch = () => lateWriter
  const original = store.conversations.clear.prepare.bind(store.conversations.clear)
  vi.spyOn(store.conversations.clear, 'prepare').mockImplementation(async (...args) => {
    const prepared = await original(...args)
    lateWriter = true
    return prepared
  })
  expect(
    await host.advanceConversationClear(intent.operationKey, new AbortController().signal)
  ).toMatchObject({ kind: 'blocked', reasons: expect.arrayContaining(['supervised-work']) })
  expect(store.conversations.read(intent.conversationId)?.contextGeneration).toBe(1)
  expect(store.conversations.clear.intent(intent.operationKey)?.phase).toBe(
    'reconciliation-required'
  )
})
