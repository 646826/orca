import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { AgentSessionPreDispatchError } from './structured-agent-session-operation-settlement'
import { readConversationTransferNoWrite } from '../conversations/conversation-transfer-no-write'
import { ConversationAuthorityRevisionChangedError } from '../conversations/conversation-context-authority-revision'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import { expect, it, vi } from 'vitest'
import { triggerClaimsFixture } from '../conversations/conversation-trigger-claims.test-fixture'
import { createStructuredConversationSwitchRuntime } from './structured-conversation-switch-runtime'

async function setup() {
  const f = await triggerClaimsFixture()
  const verifyTrigger = vi.fn()
  const composition = createStructuredConversationSwitchRuntime({
    db: f.db,
    stateDirectory: f.claimsHost.stateDirectory,
    deliveryHost: f.deliveryHost,
    preparation: {
      prepare: async () => ({
        kind: 'prepared' as const,
        plan: {
          manifestId: f.manifest.manifestId,
          delivery: 'first-turn' as const,
          sourceBoundaries: f.intent.sourceBoundaries
        }
      }),
      readPlan: () => ({
        manifestId: f.manifest.manifestId,
        delivery: 'first-turn' as const,
        sourceBoundaries: f.intent.sourceBoundaries
      }),
      verifyTrigger
    },
    ensureCandidate: async () => {},
    flushEvents: (id) => f.host.flushStreamedEvents(id),
    wakeDelivery: (id, signal) =>
      f.host.collaboratorsForTests().serialize(id, async () => {
        signal.throwIfAborted()
        void f.host.collaboratorsForTests().conversationDelivery.loop.wake(id)
      }),
    publishSourceQueue: () => {},
    reportContinuationFailure: () => {},
    now: () => 1
  })
  f.host.deps.conversationTransferAuthority = composition.transferAuthority
  f.host.deps.conversationDeliveryHost = f.deliveryHost
  const bindEvidence = vi.fn(async (sessionId: string, planId: string, signal: AbortSignal) => {
    signal.throwIfAborted()
    expect(sessionId).toBe(f.targetId)
    expect(
      f.db.prepare('SELECT plan_id FROM conversation_delivery_inputs WHERE plan_id=?').get(planId)
    ).toBeTruthy()
  })
  f.host.deps.bindConversationEvidencePlan = bindEvidence
  const signal = new AbortController().signal
  const plan = {
    manifestId: f.manifest.manifestId,
    delivery: 'first-turn' as const,
    sourceBoundaries: f.intent.sourceBoundaries
  }
  return { f, composition, signal, plan, verifyTrigger, bindEvidence }
}

it.each(['accepted', 'unknown'] as const)(
  'reserves one queued draft and reconciles %s without replay',
  async (outcome) => {
    const { f, composition, signal, plan, bindEvidence } = await setup()
    const reserved = await composition.runtime.reserveTrigger(f.intent, plan, signal)
    expect(reserved).not.toBeNull()
    const current = await f.store.conversations.progress({
      operationKey: f.intent.operationKey,
      expectedVersion: f.intent.version,
      phase: 'delivering',
      sourceBoundaries: f.intent.sourceBoundaries,
      manifestId: f.manifest.manifestId,
      deliveryReceiptId: null
    })
    f.dispatch.mockImplementation(async (input) => {
      if (outcome === 'unknown') {
        return { state: 'unknown', reason: 'lost response' }
      }
      const native = agentSessionProviderHandleChainHead(
        f.store.getRecord(f.targetId)!.providerHandleChain
      )!.handle
      await input.beforeContextDispatch?.({
        transport: 'codex',
        payload: { threadId: native.nativeId, input: input.body.blocks }
      })
      await input.beforeDispatch?.()
      return {
        state: 'accepted',
        originCorrelation: 'exact',
        providerIdentity: {
          provider: 'codex',
          threadId: native.nativeId,
          turnId: 'accepted-turn',
          ordinal: 0
        }
      }
    })
    const pending = composition.runtime.deliver(current, plan, reserved!.reservationId, signal)
    await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(f.source.queuedMessages.list()[0]?.state).toBe('withdrawn'))
    composition.notifyJournalCommitted(f.targetId)
    expect(await pending).toMatchObject({ kind: outcome })
    expect(bindEvidence).toHaveBeenCalledTimes(outcome === 'accepted' ? 1 : 0)
    expect(await composition.runtime.reconcile(current, plan, signal)).toMatchObject({
      kind: outcome
    })
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    composition.close()
  }
)

it('does not reserve paused or absent drafts, and requires the exact preparation trigger binding', async () => {
  const { f, composition, signal, plan, verifyTrigger } = await setup()
  await f.source.queuedMessages.hold({ messageIds: [f.draft.messageId], reason: 'send_failed' })
  expect(await composition.runtime.reserveTrigger(f.intent, plan, signal)).toBeNull()
  expect(verifyTrigger).not.toHaveBeenCalled()
  await f.source.queuedMessages.withdraw([f.draft.messageId])
  await f.source.queuedMessages.insert({ messageId: 'fresh-preview', body: f.draft.body })
  verifyTrigger.mockImplementation(() => {
    throw new Error('preview-trigger-changed')
  })
  await expect(composition.runtime.reserveTrigger(f.intent, plan, signal)).rejects.toThrow(
    'preview-trigger-changed'
  )
  expect(f.db.prepare('SELECT count(*) n FROM conversation_trigger_reservations').get()?.n).toBe(0)
  expect(f.dispatch).not.toHaveBeenCalled()
  composition.close()
})
it('teardown cancels pending native waits without consuming another draft', async () => {
  const { f, composition, signal, plan } = await setup()
  const reserved = await composition.runtime.reserveTrigger(f.intent, plan, signal)
  const current = await f.store.conversations.progress({
    operationKey: f.intent.operationKey,
    expectedVersion: f.intent.version,
    phase: 'delivering',
    sourceBoundaries: f.intent.sourceBoundaries,
    manifestId: f.manifest.manifestId,
    deliveryReceiptId: null
  })
  f.dispatch.mockResolvedValue({ state: 'admitted' })
  const result = composition.runtime.deliver(current, plan, reserved!.reservationId, signal)
  const rejection = expect(result).rejects.toThrow('Conversation runtime closed')
  await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(1))
  composition.close()
  await rejection
  expect(f.dispatch).toHaveBeenCalledTimes(1)
})

it('does not reserve a triggering draft held by the canonical stopped queue pause', async () => {
  const { f, composition, signal, plan } = await setup()
  const draft = f.source.queuedMessages.list()[0]!
  vi.spyOn(f.source.queuedMessages, 'pauses').mockReturnValue([
    {
      reason: 'stopped',
      since: null,
      messageIds: [draft.messageId]
    }
  ])
  expect(await composition.runtime.reserveTrigger(f.intent, plan, signal)).toBeNull()
  expect(f.dispatch).not.toHaveBeenCalled()
  composition.close()
})

it('rolls back trigger append when its source queue pauses after reservation', async () => {
  const { f, composition, signal, plan } = await setup()
  const reserved = await composition.runtime.reserveTrigger(f.intent, plan, signal)
  const current = await f.store.conversations.progress({
    operationKey: f.intent.operationKey,
    expectedVersion: f.intent.version,
    phase: 'delivering',
    sourceBoundaries: f.intent.sourceBoundaries,
    manifestId: f.manifest.manifestId,
    deliveryReceiptId: null
  })
  const draft = f.source.queuedMessages.list()[0]!
  vi.spyOn(f.source.queuedMessages, 'pauses').mockReturnValue([
    {
      reason: 'stopped',
      since: null,
      messageIds: [draft.messageId]
    }
  ])
  await expect(
    composition.runtime.deliver(current, plan, reserved!.reservationId, signal)
  ).rejects.toThrow('source queue paused or reordered')
  expect(f.source.queuedMessages.list()[0]?.state).toBe('waiting')
  expect(f.dispatch).not.toHaveBeenCalled()
  composition.close()
})

it('classifies only commit-correlated authority races as unknown receipt observations without replay', async () => {
  const { f, composition, signal, plan } = await setup()
  const reserved = await composition.runtime.reserveTrigger(f.intent, plan, signal)
  const current = await f.store.conversations.progress({
    operationKey: f.intent.operationKey,
    expectedVersion: f.intent.version,
    phase: 'delivering',
    sourceBoundaries: f.intent.sourceBoundaries,
    manifestId: f.manifest.manifestId,
    deliveryReceiptId: null
  })
  f.dispatch.mockResolvedValue({ state: 'admitted' })
  const waiting = new AbortController()
  const pending = composition.runtime.deliver(
    current,
    plan,
    reserved!.reservationId,
    waiting.signal
  )
  const stopped = expect(pending).rejects.toThrow('observation stopped')
  await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(1))
  waiting.abort(new Error('observation stopped'))
  await stopped
  const readEvidence = f.deliveryHost.readPreparationEvidence
  const stale = new ConversationAuthorityRevisionChangedError()
  try {
    f.deliveryHost.readPreparationEvidence = () => {
      throw stale
    }
    await expect(composition.runtime.reconcile(current, plan, signal)).rejects.toBe(stale)
    f.deliveryHost.readPreparationEvidence = () => {
      composition.notifyJournalCommitted(f.targetId)
      throw stale
    }
    await expect(composition.runtime.reconcile(current, plan, signal)).resolves.toEqual({
      kind: 'unknown'
    })
    const invalid = new Error('source proof is invalid')
    f.deliveryHost.readPreparationEvidence = () => {
      composition.notifyJournalCommitted(f.targetId)
      throw invalid
    }
    await expect(composition.runtime.reconcile(current, plan, signal)).rejects.toBe(invalid)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
  } finally {
    f.deliveryHost.readPreparationEvidence = readEvidence
    composition.close()
  }
})

it.each(['pre-write', 'generic-rejection', 'unknown'] as const)(
  'classifies %s from durable target evidence without requeuing the original',
  async (kind) => {
    const { f, composition, signal, plan } = await setup()
    const reserved = await composition.runtime.reserveTrigger(f.intent, plan, signal)
    const current = await f.store.conversations.progress({
      operationKey: f.intent.operationKey,
      expectedVersion: f.intent.version,
      phase: 'delivering',
      sourceBoundaries: f.intent.sourceBoundaries,
      manifestId: f.manifest.manifestId,
      deliveryReceiptId: null
    })
    f.dispatch.mockImplementation(async () => {
      if (kind === 'pre-write') {
        throw new AgentSessionPreDispatchError('test-before-native-write')
      }
      if (kind === 'unknown') {
        return { state: 'unknown', reason: 'response lost after possible write' }
      }
      return {
        state: 'rejected',
        ...agentSessionFailureWords(agentSessionFailureFact('providerRejected'), {
          surface: 'rejection'
        })
      }
    })
    const delivering = composition.runtime.deliver(current, plan, reserved!.reservationId, signal)
    await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(1))
    const target = f.deliveryHost.getJournal(f.targetId)!
    await vi.waitFor(() => expect(target.submissions().at(-1)?.dispatchState).not.toBe('pending'))
    composition.notifyJournalCommitted(f.targetId)
    const expected = kind === 'pre-write' ? 'proven-no-effect' : 'unknown'
    expect(await delivering).toEqual({ kind: expected })
    expect(await composition.runtime.reconcile(current, plan, signal)).toEqual({ kind: expected })
    expect(readConversationTransferNoWrite(f.db, reserved!.reservationId) !== null).toBe(
      kind === 'pre-write'
    )
    expect(target.submissions().at(-1)?.queuedMessageId).toBeUndefined()
    expect(f.source.queuedMessages.get(f.draft.messageId)?.state).toBe('withdrawn')
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    composition.close()
  }
)
