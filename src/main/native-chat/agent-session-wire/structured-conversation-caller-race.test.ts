import { expect, it, vi } from 'vitest'
import {
  attach,
  CALLER,
  envelope,
  ensureParams,
  hostTestState,
  seedApproval
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { mutateStructuredAgentSession } from './structured-agent-session-mutation-context'
import { sendPlan } from './structured-agent-session-mutation-plans'

const legacy = { ...CALLER, conversationMutationSupported: false }

it('rechecks a legacy send after enrollment while waiting on the production session queue', async () => {
  await attach()
  const { host, store, dispatch } = hostTestState()
  const held = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const blocking = host['serialize'](SESSION, async () => {
    entered.resolve()
    await held.promise
  })
  await entered.promise
  const body = hostTestMessage('must not reach the new aggregate')
  const sending = host.send(legacy, { body, envelope: envelope('agentSession.send', { body }) })
  await store.conversations.ensureSingleton(SESSION)
  held.resolve()
  await blocking
  expect(await sending).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'clientCapabilityMissing' } }
  })
  expect(dispatch).not.toHaveBeenCalled()
  expect(host['sessions'].get(SESSION)?.journal.submissions()).toHaveLength(0)
})

it('rechecks a command receipt inside the write after enrollment during plan preparation', async () => {
  await attach()
  const { host, store } = hostTestState()
  const body = hostTestMessage('must not be committed')
  const request = { body, envelope: envelope('agentSession.send', { body }) }
  const plan = sendPlan(request)
  const ctx = { ...host['mutationContext'](), wakeDelivery: vi.fn() }
  const result = await mutateStructuredAgentSession(ctx, legacy, request.envelope, {
    ...plan,
    run: async (turn) => {
      await store.conversations.ensureSingleton(SESSION)
      return plan.run(turn)
    }
  })
  expect(result).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'clientCapabilityMissing' } }
  })
  expect(host['sessions'].get(SESSION)?.journal.submissions()).toHaveLength(0)
  expect(ctx.wakeDelivery).not.toHaveBeenCalled()
})

it('allows receipt-only legacy replay and original approval settlement after enrollment', async () => {
  await attach()
  const { host, store } = hostTestState()
  const body = hostTestMessage('already accepted')
  const request = { body, envelope: envelope('agentSession.send', { body }) }
  const ctx = { ...host['mutationContext'](), wakeDelivery: vi.fn() }
  expect(
    await mutateStructuredAgentSession(ctx, legacy, request.envelope, sendPlan(request))
  ).toMatchObject({ ok: true })
  const prompt = await seedApproval()
  await store.conversations.ensureSingleton(SESSION)
  expect(
    await mutateStructuredAgentSession(ctx, legacy, request.envelope, sendPlan(request))
  ).toMatchObject({ ok: true, replayed: true })
  const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId: 'allow' }
  expect(
    await host.respondToPrompt(legacy, {
      kind: 'approval',
      ...fields,
      envelope: envelope('agentSession.respondTo:approval', fields)
    })
  ).toMatchObject({ ok: true })
})

it('checks tab visibility before dismissing recovery and again inside the store write', async () => {
  await attach()
  const { host, store } = hostTestState()
  const dismiss = vi.spyOn(host['restartResume'], 'dismiss')
  const check = () => {
    if (store.conversations.membership(SESSION)) {
      throw new Error('legacy aggregate mutation refused')
    }
  }
  await store.conversations.ensureSingleton(SESSION)
  await expect(
    host.setSessionTabVisibility(SESSION, false, undefined, { assertMutationSupported: check })
  ).rejects.toThrow('legacy aggregate mutation refused')
  expect(dismiss).not.toHaveBeenCalled()
  const guard = vi.fn(() => {
    throw new Error('final store admission refused')
  })
  await expect(store.setSessionTabVisibility(SESSION, false, undefined, guard)).rejects.toThrow(
    'final store admission refused'
  )
  expect(guard).toHaveBeenCalledOnce()
})

it('rechecks legacy attach after waiting behind enrollment in the native queue', async () => {
  const record = await attach()
  const { host, store, acquire } = hostTestState()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const held = host['serialize'](SESSION, async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const pending = host.attach(legacy, ensureParams(record!.lease.runtimeFence))
  await store.conversations.ensureSingleton(SESSION)
  release.resolve()
  await held
  expect(await pending).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'clientCapabilityMissing' } }
  })
  expect(acquire).toHaveBeenCalledOnce()
})
