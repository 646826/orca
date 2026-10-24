import { expect, it } from 'vitest'
import { createConversationDeliveryFixture } from './conversation-delivery.fixture'
import { assertConversationPreparationTarget } from './conversation-preparation-target'
import { finalizeConversationDeliveryReceipt } from './conversation-delivery-receipt'

it('uses frozen workspace proof only for an existing dispatch, never for another prewrite or operation', async () => {
  const f = await createConversationDeliveryFixture()
  try {
    const expected = {
      target: f.manifest.target,
      budget: f.manifest.budget,
      nativeIdentityDigest: f.plan.nativeIdentityDigest,
      runtimeFence: f.plan.runtimeFence,
      optionsDigest: 'options',
      freshNative: true,
      workspaceObservation: {
        scopeDigest: 'host-folder',
        watchIdentity: 'root',
        revision: 0,
        continuity: 'observed' as const
      }
    }
    let current = expected
    const evidence = f.authority.readPreparationEvidence
    const read = (allowDispatched: boolean, operationKey = f.plan.operationKey) => {
      assertConversationPreparationTarget(
        f.fixture.host.db,
        f.manifest,
        expected,
        current,
        1,
        allowDispatched,
        operationKey
      )
      return evidence(f.fixture.host.db, f.manifest)
    }
    f.authority.readPreparationEvidence = () => read(true)
    f.authority.readPreDispatchPreparationEvidence = () => read(false)
    f.bind()
    current = {
      ...expected,
      workspaceObservation: { ...expected.workspaceObservation, revision: 1 }
    }
    expect(read(true)).not.toBeNull()
    expect(() => read(true, 'different-operation')).toThrow('Preparation target changed')
    expect(f.bind).toThrow('Preparation target changed')
    // Genuine exact acceptance can still settle after the candidate's ordinary file writes.
    await f.journal.resolveDispatch({
      clientMessageId: 'trigger',
      fence: 1,
      state: 'accepted',
      originCorrelation: 'exact',
      providerIdentity: { provider: 'codex', threadId: 'native-thread', turnId: 'turn', ordinal: 0 }
    })
    expect(
      await finalizeConversationDeliveryReceipt(
        f.fixture.host.db,
        f.plan.planId,
        f.authority,
        f.signal
      )
    ).not.toBeNull()
    current = { ...current, optionsDigest: 'foreign-options' }
    expect(() => read(true)).toThrow('Preparation target changed')
  } finally {
    f.fixture.close()
  }
})
