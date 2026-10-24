import { expect, it, vi } from 'vitest'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { beginSwitch } from './structured-conversation-switch.test-fixture'
import {
  hostTestState,
  replaceHostTestState,
  CALLER
} from './structured-agent-session-host-test-harness'
import { HOST_TEST_NOW, hostTestOperationId } from './structured-agent-session-host-test-data'

it('refuses an originating switch replaced while candidate startup waits for its queue', async () => {
  const f = await beginSwitch()
  await f.host.close(f.targetId, 'evict')
  await f.host.flushAllStreamedEvents()
  const state = hostTestState()
  const before = state.acquire.mock.calls.length
  const acquire = state.acquire.getMockImplementation()!
  state.acquire.mockImplementation(async (input) => {
    const result = await acquire(input)
    return { ...result, link: result.link ? { ...result.link, origin: 'resumed' } : undefined }
  })
  const prepare = vi.fn(async () => ({
    kind: 'blocked' as const,
    reasons: ['capability-unverified']
  }))
  const host = new StructuredAgentSessionHost({
    ...f.host.deps,
    conversationPreparationFactory: () => ({
      preparation: { prepare, readPlan: () => null, verifyTrigger: () => {} },
      readPreparationEvidence: () => null,
      canRetrieve: () => false
    })
  })
  replaceHostTestState({ host, store: state.store })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const held = host['serialize'](f.targetId, async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const preparing = host.deps.conversationSwitchRuntime!.prepare(
    f.intent,
    'previous',
    new AbortController().signal
  )
  const rejected = expect(preparing).rejects.toMatchObject({ reason: 'stale-generation' })
  try {
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
        fingerprint: 'replacement-before-start',
        now: HOST_TEST_NOW
      }
    )
  } finally {
    release.resolve()
    await held
  }
  await rejected
  expect(state.acquire.mock.calls).toHaveLength(before)
  expect(prepare).not.toHaveBeenCalled()
  expect(state.dispatch).not.toHaveBeenCalled()
})
