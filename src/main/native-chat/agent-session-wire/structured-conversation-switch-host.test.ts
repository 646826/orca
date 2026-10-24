import { expect, it, vi } from 'vitest'
import { hostTestState, CALLER, envelope } from './structured-agent-session-host-test-harness'
import { hostTestMessage, HOST_TEST_SESSION } from './structured-agent-session-host-test-data'

import { beginSwitch } from './structured-conversation-switch.test-fixture'

it('cancels preparation without waiting for its session queues or dispatching a turn', async () => {
  const { host, store, intent } = await beginSwitch()
  const release = Promise.withResolvers<void>()
  const entered = vi.fn()
  const deliver = vi.fn(async () => ({ kind: 'unknown' as const }))
  host.deps.conversationSwitchRuntime = {
    prepare: async () => {
      entered()
      await release.promise
      return {
        kind: 'prepared',
        plan: {
          manifestId: 'cancelled-plan',
          delivery: 'passive',
          sourceBoundaries: intent.sourceBoundaries
        }
      }
    },
    readPlan: () => null,
    reserveTrigger: async () => null,
    deliver,
    reconcile: async () => ({ kind: 'unknown' })
  }
  const advancing = host.advanceConversationSwitch(
    intent.operationKey,
    new AbortController().signal
  )
  try {
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
    const current = store.conversations.read(intent.conversationId)
    if (!current) {
      throw new Error('missing conversation')
    }
    const cancelled = await store.conversations.cancel({
      operationKey: intent.operationKey,
      expectedVersion: intent.version,
      expectedRevision: current.revision,
      expectedContextGeneration: current.contextGeneration,
      expectedActivationFence: current.activationFence
    })
    expect(cancelled.phase).toBe('cancelled')
  } finally {
    release.resolve()
  }
  expect(await advancing).toEqual({ kind: 'cancelled' })
  expect(deliver).not.toHaveBeenCalled()
})

it('blocks unresolved historical evidence before preparing a switch', async () => {
  const { host, intent } = await beginSwitch()
  host.deps.journalDatabase.db
    .prepare('INSERT INTO conversation_origin_rows VALUES(?,?,?,?,?,?,?,?,?)')
    .run(
      HOST_TEST_SESSION,
      'unresolved-epoch',
      1,
      '$',
      '[]',
      null,
      intent.conversationId,
      intent.contextGeneration,
      1
    )
  const prepare = vi.fn(async () => ({ kind: 'blocked' as const, reasons: ['unexpected'] }))
  host.deps.conversationSwitchRuntime = {
    prepare,
    readPlan: () => null,
    reserveTrigger: async () => null,
    deliver: async () => ({ kind: 'unknown' }),
    reconcile: async () => ({ kind: 'unknown' })
  }
  expect(
    await host.advanceConversationSwitch(intent.operationKey, new AbortController().signal)
  ).toEqual({ kind: 'blocked', reasons: ['unresolved-source-origin'] })
  expect(prepare).not.toHaveBeenCalled()
})

it('preserves uncertain delivery without replay when late evidence loses origin before activation', async () => {
  const { host, store, intent } = await beginSwitch()
  const plan = {
    manifestId: 'prepared-context',
    delivery: 'passive' as const,
    sourceBoundaries: intent.sourceBoundaries
  }
  const deliver = vi.fn(async () => {
    host.deps.journalDatabase.db
      .prepare('INSERT INTO conversation_origin_rows VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        HOST_TEST_SESSION,
        'late-epoch',
        1,
        '$',
        '[]',
        null,
        intent.conversationId,
        intent.contextGeneration,
        1
      )
    return {
      kind: 'accepted' as const,
      receiptId: 'transport-accepted',
      candidateBoundary: intent.candidateBoundary
    }
  })
  const reconcile = vi.fn(async () => ({ kind: 'unknown' as const }))
  host.deps.conversationSwitchRuntime = {
    prepare: async () => ({ kind: 'prepared', plan }),
    readPlan: () => plan,
    reserveTrigger: async () => null,
    deliver,
    reconcile
  }
  const signal = new AbortController().signal
  expect(await host.advanceConversationSwitch(intent.operationKey, signal)).toEqual({
    kind: 'blocked',
    reasons: ['unresolved-source-origin']
  })
  expect(store.conversations.intent(intent.operationKey)?.phase).toBe('delivering')
  expect(store.conversations.route(HOST_TEST_SESSION)?.role).toBe('active')
  expect(await host.advanceConversationSwitch(intent.operationKey, signal)).toEqual({
    kind: 'reconciliation-required'
  })
  expect(deliver).toHaveBeenCalledOnce()
  expect(reconcile).toHaveBeenCalledOnce()
})

it('keeps both real host serializers free while switch preparation waits', async () => {
  const { host, targetId, intent } = await beginSwitch()
  const release = Promise.withResolvers<void>()
  const entered = vi.fn()
  host.deps.conversationSwitchRuntime = {
    prepare: async () => {
      entered()
      await release.promise
      return { kind: 'blocked', reasons: ['test-finished'] }
    },
    readPlan: () => null,
    reserveTrigger: async () => null,
    deliver: async () => ({ kind: 'unknown' }),
    reconcile: async () => ({ kind: 'unknown' })
  }
  const advancing = host.advanceConversationSwitch(
    intent.operationKey,
    new AbortController().signal
  )
  try {
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
    const completed: string[] = []
    for (const id of [HOST_TEST_SESSION, targetId]) {
      void host.collaboratorsForTests().serialize(id, async () => {
        completed.push(id)
      })
    }
    await vi.waitFor(() => expect(completed).toEqual([HOST_TEST_SESSION, targetId]))
  } finally {
    release.resolve()
    await advancing
  }
})

it('queues new user sends while idle during a switch without dispatching either', async () => {
  const { host } = await beginSwitch()
  for (const text of ['trigger', 'later intent']) {
    const body = hostTestMessage(text)
    const result = await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body, delivery: 'queue-if-active' }),
      body,
      delivery: 'queue-if-active',
      userSend: true
    })
    expect(result).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })
  }
  const session = host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)
  expect(
    session?.journal.queuedMessages.list().filter((row) => row.state === 'waiting')
  ).toHaveLength(2)
  expect(session?.journal.submissions()).toHaveLength(0)
  expect(hostTestState().dispatch).not.toHaveBeenCalled()
})

it('blocks switching when supervised ownership cannot be checked', async () => {
  const { host, intent } = await beginSwitch()
  delete host.deps.hasOpenDispatch
  const prepare = vi.fn(async () => ({ kind: 'blocked' as const, reasons: ['unexpected'] }))
  host.deps.conversationSwitchRuntime = {
    prepare,
    readPlan: () => null,
    reserveTrigger: async () => null,
    deliver: async () => ({ kind: 'unknown' }),
    reconcile: async () => ({ kind: 'unknown' })
  }
  expect(
    await host.advanceConversationSwitch(intent.operationKey, new AbortController().signal)
  ).toEqual({ kind: 'blocked', reasons: ['owner-unverifiable'] })
  expect(prepare).not.toHaveBeenCalled()
})

it('never falls through to immediate dispatch when the client cannot queue an image', async () => {
  const { host } = await beginSwitch()
  const body = hostTestMessage('image intent')
  body.blocks.push({ type: 'image-ref', path: '/tmp/switch-image.png' })
  const result = await host.send(CALLER, {
    envelope: envelope('agentSession.send', { body, delivery: 'queue-if-active' }),
    body,
    delivery: 'queue-if-active',
    queuedImageCards: false
  })
  expect(result).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'conversationSwitchInFlight' } }
  })
  expect(
    host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal.submissions()
  ).toHaveLength(0)
  expect(hostTestState().dispatch).not.toHaveBeenCalled()
})
