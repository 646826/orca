import { expect, it, vi } from 'vitest'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { hostTestState } from './structured-agent-session-host-test-harness'
import { createConversationEvidenceLaunchGate } from '../conversations/conversation-evidence-launch-gate'

it('constructs actual host-local access before publishing the runtime services and closes them on teardown', async () => {
  const original = hostTestState().host
  const prepare = vi.fn(async () => ({
    kind: 'blocked' as const,
    reasons: ['capability-unverified']
  }))
  const factory = vi.fn(
    (access: Parameters<NonNullable<typeof original.deps.conversationPreparationFactory>>[0]) => {
      expect(access.getRecord('missing')).toBeNull()
      expect(access.getJournal('missing')).toBeNull()
      return {
        preparation: {
          prepare,
          readPlan: () => null,
          verifyTrigger: () => {
            throw new Error('unverified')
          }
        },
        readPreparationEvidence: () => null,
        canRetrieve: () => false
      }
    }
  )
  const host = new StructuredAgentSessionHost({
    ...original.deps,
    conversationPreparationFactory: factory
  })
  try {
    expect(factory).toHaveBeenCalledTimes(1)
    expect(host.deps.conversationDeliveryHost).toBeDefined()
    expect(host.deps.conversationSwitchRuntime).toBeDefined()
    expect(host.deps.conversationTransferAuthority).toBeDefined()
    host.stopDelivery()
    await expect(
      host.deps.conversationSwitchRuntime!.reconcile(
        {
          operationKey: 'missing',
          conversationId: 'c',
          targetSessionId: 't',
          contextGeneration: 1,
          activationFence: 1,
          nativeBindingGeneration: 1,
          version: 1,
          phase: 'delivering',
          sourceBoundaries: [],
          candidateSegmentId: null,
          candidateBaseline: [],
          candidateBoundary: { sessionId: 't', epoch: 'e', endSequence: 0 },
          manifestId: 'missing',
          deliveryReceiptId: null
        },
        { manifestId: 'missing', delivery: 'first-turn', sourceBoundaries: [] },
        new AbortController().signal
      )
    ).rejects.toThrow('Conversation runtime closed')
    expect(prepare).not.toHaveBeenCalled()
  } finally {
    await host.flushAllStreamedEvents()
  }
})

it('starts an inactive candidate through real host acquisition before preparation without a model turn', async () => {
  const { beginSwitch } = await import('./structured-conversation-switch.test-fixture')
  const { replaceHostTestState } = await import('./structured-agent-session-host-test-harness')
  const f = await beginSwitch()
  await f.host.flushAllStreamedEvents()
  const state = hostTestState()
  const before = state.acquire.mock.calls.length
  const acquire = state.acquire.getMockImplementation()!
  state.acquire.mockImplementation(async (input) => {
    const result = await acquire(input)
    return { ...result, link: result.link ? { ...result.link, origin: 'resumed' } : undefined }
  })
  const prepare = vi.fn(async () => {
    expect(state.acquire.mock.calls.length).toBe(before + 1)
    expect(state.dispatch).not.toHaveBeenCalled()
    return { kind: 'blocked' as const, reasons: ['capability-unverified'] }
  })
  const host = new StructuredAgentSessionHost({
    ...f.host.deps,
    conversationPreparationFactory: () => ({
      preparation: {
        prepare,
        readPlan: () => null,
        verifyTrigger: () => {
          throw new Error('unverified')
        }
      },
      readPreparationEvidence: () => null,
      canRetrieve: () => false
    })
  })
  replaceHostTestState({ host, store: state.store })
  expect(host.collaboratorsForTests().sessions.get(f.targetId)).toBeUndefined()
  expect(
    await host.deps.conversationSwitchRuntime!.prepare(
      f.intent,
      'previous',
      new AbortController().signal
    )
  ).toEqual({ kind: 'blocked', reasons: ['capability-unverified'] })
  expect(prepare).toHaveBeenCalledOnce()
  expect(state.dispatch).not.toHaveBeenCalled()
})

it('does not rebind an old candidate start when its operation changes during launch resolution', async () => {
  const { beginSwitch } = await import('./structured-conversation-switch.test-fixture')
  const { replaceHostTestState, CALLER } =
    await import('./structured-agent-session-host-test-harness')
  const { HOST_TEST_NOW, hostTestOperationId } =
    await import('./structured-agent-session-host-test-data')
  const f = await beginSwitch()
  await f.host.close(f.targetId, 'evict')
  await f.host.flushAllStreamedEvents()
  const state = hostTestState()
  const before = state.acquire.mock.calls.length
  const gate = createConversationEvidenceLaunchGate(f.host.deps.journalDatabase.db)
  const prepare = vi.fn(async () => ({
    kind: 'blocked' as const,
    reasons: ['capability-unverified']
  }))
  const capture = vi.fn(
    (
      sessionId: string,
      _fence: number,
      signal: AbortSignal | undefined,
      expectedOperationKey: string | null
    ) => {
      expect(expectedOperationKey).toBe(f.intent.operationKey)
      return gate.capture(
        sessionId,
        signal,
        () => {
          throw new Error('must not register')
        },
        expectedOperationKey
      )
    }
  )
  const host = new StructuredAgentSessionHost({
    ...f.host.deps,
    resolveLaunchEnv: async () => {
      const conversation = state.store.conversations.read(f.intent.conversationId)!
      await state.store.conversations.cancel({
        operationKey: f.intent.operationKey,
        expectedVersion: f.intent.version,
        expectedRevision: conversation.revision,
        expectedContextGeneration: conversation.contextGeneration,
        expectedActivationFence: conversation.activationFence
      })
      const current = state.store.conversations.read(f.intent.conversationId)!
      await state.store.conversations.beginSwitch(
        {
          conversationId: current.conversationId,
          expectedRevision: current.revision,
          expectedContextGeneration: current.contextGeneration,
          expectedActivationFence: current.activationFence,
          target: state.store.getRecord(f.targetId)!,
          expectedNativeBindingGeneration: 1
        },
        {
          callerKey: CALLER.callerKey,
          operationId: hostTestOperationId(),
          fingerprint: 'replacement-start',
          now: HOST_TEST_NOW
        }
      )
      return {}
    },
    conversationPreparationFactory: () => ({
      captureConversationEvidenceLaunch: capture,
      preparation: { prepare, readPlan: () => null, verifyTrigger: () => {} },
      readPreparationEvidence: () => null,
      canRetrieve: () => false
    })
  })
  replaceHostTestState({ host, store: state.store })
  await expect(
    host.deps.conversationSwitchRuntime!.prepare(f.intent, 'previous', new AbortController().signal)
  ).rejects.toMatchObject({
    cause: { code: 'agent_session_operation_invalid', ownerVerdict: 'exited' }
  })
  // The mandatory host scope check rejects before even consulting optional evidence registration.
  expect(capture).not.toHaveBeenCalled()
  expect(state.store.conversations.read(f.intent.conversationId)?.pendingOperationKey).not.toBe(
    f.intent.operationKey
  )
  expect(state.acquire.mock.calls).toHaveLength(before)
  expect(prepare).not.toHaveBeenCalled()
  expect(state.dispatch).not.toHaveBeenCalled()
})
