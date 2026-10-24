import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createConversationSwitchCoordinator } from './conversation-switch'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import type {
  ConversationSwitchPlan,
  ConversationSwitchPorts
} from './conversation-switch-contracts'

let fixture: Awaited<ReturnType<typeof createConversationSwitchFixture>>
let records: Awaited<ReturnType<typeof createConversationSwitchFixture>>['records']
let ports: Awaited<ReturnType<typeof createConversationSwitchFixture>>['ports']
let operationKey: string
let plans: Map<string, ConversationSwitchPlan>
let append: (sessionId: string, seq: number) => void
const signal = new AbortController().signal
beforeEach(async () => {
  fixture = await createConversationSwitchFixture()
  ;({ records, ports, operationKey, plans, append } = fixture)
})
afterEach(() => fixture.close())
it('commits delivery intent before effect and activates only verified whole-plan acceptance', async () => {
  const deliver = ports.deliver
  ports.deliver = vi.fn<ConversationSwitchPorts['deliver']>(async (...args) => {
    expect(records.conversations.intent(operationKey)?.phase).toBe('delivering')
    expect(records.conversations.route('session-a').role).toBe('active')
    return deliver(...args)
  })
  expect(
    (await createConversationSwitchCoordinator(ports).advance(operationKey, signal)).kind
  ).toBe('activated')
  expect(records.conversations.route('session-b').role).toBe('active')
  expect(ports.deliver).toHaveBeenCalledTimes(1)
})
it('keeps zero-trigger first-turn mode prepared and dispatches the reserved trigger before activation', async () => {
  const prepare = ports.prepare
  ports.prepare = async (...args) => {
    const result = await prepare(...args)
    if (result.kind === 'prepared') {
      result.plan.delivery = 'first-turn'
    }
    return result
  }
  const coordinator = createConversationSwitchCoordinator(ports)
  expect(await coordinator.advance(operationKey, signal)).toEqual({ kind: 'waiting-trigger' })
  expect(records.conversations.intent(operationKey)?.phase).toBe('prepared')
  expect(ports.deliver).not.toHaveBeenCalled()
  ports.reserveTrigger = vi.fn<ConversationSwitchPorts['reserveTrigger']>(async () => ({
    reservationId: 'reserved-one'
  }))
  expect((await coordinator.advance(operationKey, signal)).kind).toBe('activated')
  expect(ports.deliver).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    'reserved-one',
    signal
  )
})
it('reconciles a lost dispatch response without ever redispatching the trigger', async () => {
  ports.deliver = vi.fn<ConversationSwitchPorts['deliver']>(async () => {
    throw new Error('connection lost after effect')
  })
  const coordinator = createConversationSwitchCoordinator(ports)
  expect(await coordinator.advance(operationKey, signal)).toEqual({
    kind: 'reconciliation-required'
  })
  expect(records.conversations.intent(operationKey)?.phase).toBe('reconciliation-required')
  expect(await createConversationSwitchCoordinator(ports).advance(operationKey, signal)).toEqual({
    kind: 'reconciliation-required'
  })
  expect(ports.deliver).toHaveBeenCalledTimes(1)
  expect(ports.reconcile).toHaveBeenCalledTimes(1)
})
it('persists reconciliation after late source evidence without discarding the evidence', async () => {
  const deliver = ports.deliver
  ports.deliver = async (...args) => {
    const result = await deliver(...args)
    append('session-a', 2)
    return result
  }
  expect(await createConversationSwitchCoordinator(ports).advance(operationKey, signal)).toEqual({
    kind: 'reconciliation-required'
  })
  expect(records.conversations.intent(operationKey)?.phase).toBe('reconciliation-required')
  expect(records.conversations.route('session-a').role).toBe('active')
  const intent = records.conversations.intent(operationKey)
  if (!intent) {
    throw new Error('missing fixture intent')
  }
  expect(ports.readSources(intent)[0].endSequence).toBe(2)
})
it('does not dispatch when quiescence is blocked or renewed consent is needed', async () => {
  ports.quiesce = async () => ({ kind: 'blocked', reasons: ['pending-approval'] })
  expect(await createConversationSwitchCoordinator(ports).advance(operationKey, signal)).toEqual({
    kind: 'blocked',
    reasons: ['pending-approval']
  })
  expect(ports.prepare).not.toHaveBeenCalled()
  ports.quiesce = async () => ({ kind: 'ready' })
  ports.prepare = async () => ({ kind: 'waiting-consent' })
  expect(await createConversationSwitchCoordinator(ports).advance(operationKey, signal)).toEqual({
    kind: 'waiting-consent'
  })
  expect(ports.deliver).not.toHaveBeenCalled()
})
it('recovers accepted delivery after a lost response without a second user turn', async () => {
  const deliver = ports.deliver
  ports.deliver = vi.fn<ConversationSwitchPorts['deliver']>(async (...args) => {
    await deliver(...args)
    throw new Error('lost receipt response')
  })
  const coordinator = createConversationSwitchCoordinator(ports)
  expect((await coordinator.advance(operationKey, signal)).kind).toBe('reconciliation-required')
  ports.reconcile = vi.fn<ConversationSwitchPorts['reconcile']>(async (intent) => ({
    kind: 'accepted',
    receiptId: 'receipt',
    candidateBoundary: intent.candidateBoundary
  }))
  expect(
    (await createConversationSwitchCoordinator(ports).advance(operationKey, signal)).kind
  ).toBe('activated')
  expect(ports.deliver).toHaveBeenCalledTimes(1)
})
it('allows only one competing coordinator to claim dispatch', async () => {
  const results = await Promise.allSettled([
    createConversationSwitchCoordinator(ports).advance(operationKey, signal),
    createConversationSwitchCoordinator(ports).advance(operationKey, signal)
  ])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(ports.deliver).toHaveBeenCalledTimes(1)
  expect(records.conversations.route('session-b').role).toBe('active')
})
it('catches a source revision arriving inside the final activation CAS', async () => {
  const activate = records.conversations.activate.bind(records.conversations)
  vi.spyOn(records.conversations, 'activate').mockImplementation(async (request) => {
    append('session-a', 2)
    return activate(request)
  })
  expect(
    (await createConversationSwitchCoordinator(ports).advance(operationKey, signal)).kind
  ).toBe('reconciliation-required')
  expect(records.conversations.route('session-a').role).toBe('active')
})
it('requires renewed consent and quiescence before a passive supplement, never replaying a trigger', async () => {
  const deliver = ports.deliver
  ports.deliver = vi.fn<ConversationSwitchPorts['deliver']>(async (...args) => {
    const result = await deliver(...args)
    append('session-a', 2)
    return result
  })
  const coordinator = createConversationSwitchCoordinator(ports)
  expect((await coordinator.advance(operationKey, signal)).kind).toBe('reconciliation-required')
  ports.reconcile = vi.fn<ConversationSwitchPorts['reconcile']>(async (intent) => ({
    kind: 'accepted',
    receiptId: 'receipt',
    candidateBoundary: intent.candidateBoundary
  }))
  ports.quiesce = vi.fn<ConversationSwitchPorts['quiesce']>(async () => ({
    kind: 'blocked',
    reasons: ['active-tool']
  }))
  expect(await coordinator.advance(operationKey, signal)).toEqual({
    kind: 'blocked',
    reasons: ['active-tool']
  })
  ports.quiesce = async () => ({ kind: 'ready' })
  ports.prepare = vi.fn<ConversationSwitchPorts['prepare']>(async () => ({
    kind: 'waiting-consent'
  }))
  expect(await coordinator.advance(operationKey, signal)).toEqual({ kind: 'waiting-consent' })
  expect(ports.deliver).toHaveBeenCalledTimes(1)
  ports.prepare = vi.fn<ConversationSwitchPorts['prepare']>(async (intent) => {
    const plan: ConversationSwitchPlan = {
      manifestId: 'supplement',
      delivery: 'passive',
      sourceBoundaries: ports.readSources(intent)
    }
    plans.set(plan.manifestId, plan)
    return { kind: 'prepared', plan }
  })
  ports.deliver = vi.fn<ConversationSwitchPorts['deliver']>(async (...args) => deliver(...args))
  expect((await coordinator.advance(operationKey, signal)).kind).toBe('activated')
  expect(ports.deliver).toHaveBeenCalledTimes(1)
  expect(ports.reserveTrigger).not.toHaveBeenCalled()
  expect(plans.has('manifest')).toBe(true)
  expect(plans.has('supplement')).toBe(true)
})

it('keeps a post-dispatch invalidated preparation in reconciliation without replaying its accepted turn', async () => {
  const deliver = ports.deliver
  ports.deliver = vi.fn<ConversationSwitchPorts['deliver']>(async (...args) => {
    const accepted = await deliver(...args)
    // Native/source authority can invalidate preparation after an accepted external effect.
    plans.delete(args[1].manifestId)
    return accepted
  })
  expect(await createConversationSwitchCoordinator(ports).advance(operationKey, signal)).toEqual({
    kind: 'reconciliation-required'
  })
  expect(records.conversations.route('session-a').role).toBe('active')
  expect(await createConversationSwitchCoordinator(ports).advance(operationKey, signal)).toEqual({
    kind: 'reconciliation-required'
  })
  expect(ports.deliver).toHaveBeenCalledOnce()
  expect(ports.reconcile).not.toHaveBeenCalled()
})

it('retains a proven-unsent intention for an explicit recovery action without retrying on reconciliation', async () => {
  ports.deliver = vi.fn<ConversationSwitchPorts['deliver']>(async () => ({
    kind: 'proven-no-effect'
  }))
  ports.reconcile = vi.fn<ConversationSwitchPorts['reconcile']>(async () => ({
    kind: 'proven-no-effect'
  }))
  const coordinator = createConversationSwitchCoordinator(ports)
  expect(await coordinator.advance(operationKey, signal)).toEqual({
    kind: 'reconciliation-required'
  })
  const preparations = vi.mocked(ports.prepare).mock.calls.length
  expect(await coordinator.advance(operationKey, signal)).toEqual({
    kind: 'reconciliation-required'
  })
  expect(await createConversationSwitchCoordinator(ports).advance(operationKey, signal)).toEqual({
    kind: 'reconciliation-required'
  })
  expect(ports.deliver).toHaveBeenCalledTimes(1)
  expect(ports.prepare).toHaveBeenCalledTimes(preparations)
  expect(records.conversations.intent(operationKey)?.phase).toBe('reconciliation-required')
})
