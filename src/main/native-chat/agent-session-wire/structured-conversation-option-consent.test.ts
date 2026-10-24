import { expect, it } from 'vitest'
import { CALLER } from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { createCodexConversationRoundtripFixture } from './structured-conversation-roundtrip.test-fixture'
import { structuredAgentSessionMessageSendMutation } from '../../../shared/structured-agent-session-send-mutation'

it.each([
  ...(['reported-effort', 'catalog-effort', 'legacy-fast'] as const).flatMap((kind) =>
    (['missing', 'selected'] as const).map((selection) => ({ kind, selection }))
  ),
  { kind: 'legacy-fast' as const, selection: 'saved-legacy' as const }
])('requires explicit consent before transfer: $kind $selection', async ({ kind, selection }) => {
  const f = await createCodexConversationRoundtripFixture({
    ...(kind === 'reported-effort' ? { effort: 'medium' } : {}),
    catalog: kind === 'catalog-effort'
  })
  try {
    await f.enrollSource({ options: { model: 'gpt-live' } })
    if (kind === 'catalog-effort') {
      f.codex.routes['model/list'] = () => ({
        data: [
          {
            model: 'gpt-live',
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium' }]
          }
        ],
        nextCursor: null
      })
      f.codex.routes['config/read'] = () => ({ config: {} })
      expect(await f.discoverCatalog()).toMatchObject({
        models: [{ id: 'gpt-live', defaultEffort: 'medium' }]
      })
    }
    const source = f.send(HOST_TEST_SESSION, 'Keep the original decision.')
    await f.acceptNative(HOST_TEST_SESSION, 'Original response.')
    expect(await source).toMatchObject({ ok: true })
    expect(f.state.store.getRecord(HOST_TEST_SESSION)?.options).toMatchObject({
      model: 'gpt-live',
      ...(kind === 'legacy-fast' ? {} : { effort: 'medium' })
    })
    const resolved: Record<string, string> =
      kind === 'legacy-fast' ? { serviceTier: 'default' } : { effort: 'medium' }
    const options = {
      model: 'gpt-live',
      ...(kind === 'legacy-fast' && selection !== 'selected' ? { fastMode: 'false' } : {}),
      ...(selection !== 'missing' ? resolved : {})
    }
    const intent = await f.foundTarget(HOST_TEST_SESSION, f.targetId, { options })
    await expect(f.host.advanceConversationSwitch(intent.operationKey, f.signal)).rejects.toThrow(
      'Candidate native acquisition refused'
    )
    const trust = f.host.deps.conversationEvidenceTrust!.read(intent.operationKey)!
    f.host.deps.conversationEvidenceTrust!.approve(
      { operationKey: intent.operationKey, choiceDigest: trust.choiceDigest },
      CALLER.callerKey
    )
    expect(await f.host.advanceConversationSwitch(intent.operationKey, f.signal)).toMatchObject({
      kind: 'blocked',
      reasons: ['recipient-approval-required']
    })
    expect(await f.send(HOST_TEST_SESSION, 'Continue the decision.', true)).toMatchObject({
      ok: true
    })
    const controls = f.host.deps.conversationPreparationControls!
    const capability = f.host.deps.adapter.contextDeliveryCapabilities?.(f.targetId)
    controls.read(intent.operationKey)
    expect(f.host.deps.adapter.contextDeliveryCapabilities?.(f.targetId)).toEqual(capability)
    if (selection !== 'selected') {
      expect(controls.read(intent.operationKey)).toMatchObject({
        status: 'target-unavailable',
        target: null
      })
      expect(await f.host.advanceConversationSwitch(intent.operationKey, f.signal)).toMatchObject({
        kind: 'blocked'
      })
      expect(f.state.store.getRecord(f.targetId)?.options).toEqual(options)
      expect(
        f.host.collaboratorsForTests().sessions.get(f.targetId)!.journal.submissions()
      ).toEqual([])
      expect(
        f.host
          .collaboratorsForTests()
          .sessions.get(HOST_TEST_SESSION)!
          .journal.queuedMessages.list()
      ).toMatchObject([{ state: 'waiting' }])
      expect(
        f.codex.connections.flatMap((c) => c.calls.filter((call) => call.method === 'turn/start'))
      ).toHaveLength(1)
      return
    }
    f.approve(f.state.store.conversations.intent(intent.operationKey)!)
    expect(await f.host.advanceConversationSwitch(intent.operationKey, f.signal)).toEqual({
      kind: 'waiting-consent'
    })
    f.consent(intent)
    const outward = f.host.advanceConversationSwitch(intent.operationKey, f.signal)
    const wire = await f.acceptNative(f.targetId, 'Decision retained with selected effort.')
    expect(await outward).toMatchObject({ kind: 'activated' })
    expect(wire).toMatchObject({ model: 'gpt-live', ...resolved })
    expect(f.state.store.getRecord(f.targetId)?.options).toEqual(options)
    expect(
      f.host.collaboratorsForTests().sessions.get(f.targetId)!.journal.submissions()
    ).toMatchObject([{ dispatchState: 'accepted' }])
  } finally {
    await f.close()
  }
})

it.each(['missing', 'unknown-baseline', 'saved-unstable', 'selected'] as const)(
  'requires consent to the restored native service tier on return: %s tier',
  async (selection) => {
    const f = await createCodexConversationRoundtripFixture()
    const options = {
      model: 'gpt-live',
      ...(['saved-unstable', 'selected'].includes(selection) ? { serviceTier: 'default' } : {})
    }
    try {
      await f.enrollSource({ options })
      f.codex.routes['config/read'] = () => ({
        config: selection === 'unknown-baseline' ? {} : { service_tier: 'default' }
      })
      const first = f.host.send(CALLER, {
        ...structuredAgentSessionMessageSendMutation({
          sessionId: HOST_TEST_SESSION,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: f.state.store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
          body: hostTestMessage('Use another model for this one message.'),
          options: { model: 'gpt-other', serviceTier: 'priority' }
        }),
        userSend: true
      })
      expect(
        await f.acceptNative(HOST_TEST_SESSION, 'One-message override completed.')
      ).toMatchObject({
        model: 'gpt-other',
        serviceTier: 'priority'
      })
      expect(await first).toMatchObject({ ok: true })
      expect(f.state.store.getRecord(HOST_TEST_SESSION)?.options).toEqual(options)
      if (selection === 'selected') {
        const baseline = f.send(HOST_TEST_SESSION, 'Continue on the saved baseline.')
        expect(await f.acceptNative(HOST_TEST_SESSION, 'Saved baseline restored.')).toMatchObject({
          model: 'gpt-live',
          serviceTier: 'default'
        })
        expect(await baseline).toMatchObject({ ok: true })
      }
      const outward = await f.foundTarget(HOST_TEST_SESSION, f.targetId, {
        options: { model: 'gpt-live' }
      })
      await expect(
        f.host.advanceConversationSwitch(outward.operationKey, f.signal)
      ).rejects.toThrow('Candidate native acquisition refused')
      const trust = f.host.deps.conversationEvidenceTrust!.read(outward.operationKey)!
      f.host.deps.conversationEvidenceTrust!.approve(
        { operationKey: outward.operationKey, choiceDigest: trust.choiceDigest },
        CALLER.callerKey
      )
      expect(await f.host.advanceConversationSwitch(outward.operationKey, f.signal)).toMatchObject({
        kind: 'blocked',
        reasons: ['recipient-approval-required']
      })
      expect(await f.send(HOST_TEST_SESSION, 'Switch to B.', true)).toMatchObject({ ok: true })
      f.approve(f.state.store.conversations.intent(outward.operationKey)!)
      expect(await f.host.advanceConversationSwitch(outward.operationKey, f.signal)).toEqual({
        kind: 'waiting-consent'
      })
      f.consent(outward)
      const toB = f.host.advanceConversationSwitch(outward.operationKey, f.signal)
      await f.acceptNative(f.targetId, 'B response.')
      expect(await toB).toMatchObject({ kind: 'activated' })
      const returning = await f.beginReturn(f.targetId, HOST_TEST_SESSION)
      expect(await f.send(f.targetId, 'Return to A.', true)).toMatchObject({ ok: true })
      const capability = f.host.deps.adapter.contextDeliveryCapabilities?.(HOST_TEST_SESSION)
      f.host.deps.conversationPreparationControls!.read(returning.operationKey)
      expect(f.host.deps.adapter.contextDeliveryCapabilities?.(HOST_TEST_SESSION)).toEqual(
        capability
      )
      if (selection !== 'selected') {
        expect(
          f.host.deps.conversationPreparationControls!.read(returning.operationKey)
        ).toMatchObject({
          status: 'target-unavailable',
          target: null
        })
        expect(
          await f.host.advanceConversationSwitch(returning.operationKey, f.signal)
        ).toMatchObject({
          kind: 'blocked'
        })
        expect(f.state.store.getRecord(HOST_TEST_SESSION)?.options).toEqual(options)
        expect(
          f.codex.connections.flatMap((c) => c.calls.filter((call) => call.method === 'turn/start'))
        ).toHaveLength(2)
        expect(
          f.host.collaboratorsForTests().sessions.get(f.targetId)!.journal.queuedMessages.list()
        ).toMatchObject([{ state: 'waiting' }])
        return
      }
      f.approve(returning)
      expect(await f.host.advanceConversationSwitch(returning.operationKey, f.signal)).toEqual({
        kind: 'waiting-consent'
      })
      f.consent(returning)
      const toA = f.host.advanceConversationSwitch(returning.operationKey, f.signal)
      expect(
        await f.acceptNative(HOST_TEST_SESSION, 'A resumed with selected tier.')
      ).toMatchObject({
        model: 'gpt-live',
        serviceTier: 'default'
      })
      expect(await toA).toMatchObject({ kind: 'activated' })
      expect(f.state.store.getRecord(HOST_TEST_SESSION)?.options).toEqual(options)
    } finally {
      await f.close()
    }
  }
)
