import { afterEach, beforeEach, expect, it } from 'vitest'
import { createConversationDeliveryFixture } from './conversation-delivery.fixture'
import { assertConversationEvidenceScope } from './conversation-evidence-scope'
import { finalizeConversationDeliveryReceipt } from './conversation-delivery-receipt'

let f: Awaited<ReturnType<typeof createConversationDeliveryFixture>>
beforeEach(async () => {
  f = await createConversationDeliveryFixture()
})
afterEach(() => f.fixture.close())
function scope() {
  return assertConversationEvidenceScope(
    f.fixture.host.db,
    f.plan.planId,
    {
      ...f.authority,
      readAcquisition: () => ({ acquisitionGeneration: 'acquired', capabilityFingerprint: 'caps' })
    },
    'acquired'
  )
}
it('admits a durably reserved candidate only after final native input, before activation', () => {
  expect(scope).toThrow()
  f.bind()
  expect(scope().mode).toBe('candidate')
})
it('rejects cancelled candidates, clear-context and changed acquisitions', () => {
  f.bind()
  expect(() =>
    assertConversationEvidenceScope(
      f.fixture.host.db,
      f.plan.planId,
      {
        ...f.authority,
        readAcquisition: () => null
      },
      'acquired'
    )
  ).toThrow()
  f.fixture.host.db
    .prepare("UPDATE conversations SET record_json=json_set(record_json,'$.contextGeneration',2)")
    .run()
  expect(scope).toThrow()
})
it('rejects revoked preparation while a candidate is still executing', () => {
  f.bind()
  f.authority.readPreparationEvidence = () => null
  expect(scope).toThrow()
})
it('requires genuine accepted receipt for active access, without renewing old preparation', async () => {
  f.bind()
  const intent = f.fixture.records.conversations.intent(f.fixture.operationKey)!
  const makeActive = (receiptId: string | null) => {
    f.fixture.host.db
      .prepare(
        "UPDATE conversations SET record_json=json_set(record_json,'$.activeSegmentId',?,'$.pendingOperationKey',NULL)"
      )
      .run(intent.candidateSegmentId)
    f.fixture.host.db
      .prepare(
        "UPDATE conversation_switch_intents SET record_json=json_set(record_json,'$.phase','activated','$.deliveryReceiptId',?) WHERE operation_key=?"
      )
      .run(receiptId, intent.operationKey)
  }
  makeActive(null)
  expect(scope).toThrow()
  // Restore the real pending plan to construct receipt from actual journal acceptance.
  f.fixture.host.db
    .prepare("UPDATE conversations SET record_json=json_set(record_json,'$.pendingOperationKey',?)")
    .run(intent.operationKey)
  f.fixture.host.db
    .prepare('UPDATE conversation_switch_intents SET record_json=? WHERE operation_key=?')
    .run(JSON.stringify(intent), intent.operationKey)
  await f.journal.resolveDispatch({
    clientMessageId: 'trigger',
    fence: 1,
    state: 'accepted',
    originCorrelation: 'exact',
    providerIdentity: { provider: 'codex', threadId: 'native-thread', turnId: 'turn', ordinal: 0 }
  })
  const receipt = await finalizeConversationDeliveryReceipt(
    f.fixture.host.db,
    f.plan.planId,
    f.authority,
    f.signal
  )
  expect(receipt).not.toBeNull()
  makeActive(receipt!.deliveryReceiptId)
  f.authority.readPreparationEvidence = () => null
  expect(scope().mode).toBe('active')
  f.fixture.host.db.prepare('DELETE FROM conversation_delivery_receipts').run()
  expect(scope).toThrow()
})
