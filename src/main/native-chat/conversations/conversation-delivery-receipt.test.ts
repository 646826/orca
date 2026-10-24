import { readPinnedQueuedMessageEvidence } from '../agent-session-journal/queued-message-origin'
import { readConversationTransfer } from './conversation-trigger-reservation'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createConversationDeliveryFixture } from './conversation-delivery.fixture'
import {
  finalizeConversationDeliveryReceipt,
  readConversationDeliveryReceipt
} from './conversation-delivery-receipt'

type Fixture = Awaited<ReturnType<typeof createConversationDeliveryFixture>>
let fixture: Fixture['fixture']
let journal: Fixture['journal']
let authority: Fixture['authority']
let plan: Fixture['plan']
let signal: AbortSignal
let bind: Fixture['bind']
beforeEach(async () => {
  ;({ fixture, journal, authority, plan, signal, bind } = await createConversationDeliveryFixture())
})
afterEach(() => fixture.close())
it('does not promote host admission, pending or unknown into whole-plan acceptance', async () => {
  bind()
  expect(
    await finalizeConversationDeliveryReceipt(fixture.host.db, plan.planId, authority, signal)
  ).toBeNull()
  const reserved = readConversationTransfer(fixture.host.db, 'transfer')
  const original = () =>
    readPinnedQueuedMessageEvidence(fixture.host.db, {
      ownerId: 'conversation-transfer:transfer',
      sourceSessionId: 'session-a',
      messageId: 'draft',
      fingerprint: reserved!.binding.sourceFingerprint
    })
  const queued = original()
  await journal.resolveDispatch({ clientMessageId: 'trigger', fence: 1, state: 'unknown' })
  expect(
    await finalizeConversationDeliveryReceipt(fixture.host.db, plan.planId, authority, signal)
  ).toBeNull()
  expect(bind).toThrow('Native input is not the candidate submission')
  expect(readConversationTransfer(fixture.host.db, 'transfer')).toEqual(reserved)
  expect(original()).toEqual(queued)
  expect(queued).not.toBeNull()
})
it('constructs readable evidence only after canonical native acceptance', async () => {
  bind()
  await journal.resolveDispatch({
    clientMessageId: 'trigger',
    fence: 1,
    state: 'accepted',
    originCorrelation: 'exact',
    providerIdentity: { provider: 'codex', threadId: 'native-thread', turnId: 'turn', ordinal: 0 }
  })
  const receipt = await finalizeConversationDeliveryReceipt(
    fixture.host.db,
    plan.planId,
    authority,
    signal
  )
  expect(receipt).not.toBeNull()
  if (!receipt) {
    throw new Error('missing receipt')
  }
  expect(
    readConversationDeliveryReceipt(fixture.host.db, receipt.deliveryReceiptId, authority)
  ).toEqual(receipt)
  expect(receipt.operationKey).toBe(fixture.operationKey)
})
it('refuses unobserved serialized input and in-place command acceptance', async () => {
  await journal.resolveDispatch({
    clientMessageId: 'trigger',
    fence: 1,
    state: 'accepted',
    providerIdentity: null
  })
  expect(
    await finalizeConversationDeliveryReceipt(fixture.host.db, plan.planId, authority, signal)
  ).toBeNull()
})
it('does not absorb unrelated candidate output into the accepted readback', async () => {
  bind()
  await journal.resolveDispatch({
    clientMessageId: 'trigger',
    fence: 1,
    state: 'accepted',
    originCorrelation: 'exact',
    providerIdentity: { provider: 'codex', threadId: 'native-thread', turnId: 'turn', ordinal: 0 }
  })
  await journal.appendItem(
    { provider: 'codex', threadId: 'native-thread', turnId: 'foreign-turn', ordinal: 3 },
    {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'unrelated native activity' }]
    },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  expect(
    await finalizeConversationDeliveryReceipt(fixture.host.db, plan.planId, authority, signal)
  ).toBeNull()
})
it('does not authorize a second native write from an already observed input', () => {
  bind()
  expect(bind).toThrow('reconcile before replay')
})
it('rejects stale capability evidence after native acceptance', async () => {
  bind()
  await journal.resolveDispatch({
    clientMessageId: 'trigger',
    fence: 1,
    state: 'accepted',
    originCorrelation: 'exact',
    providerIdentity: { provider: 'codex', threadId: 'native-thread', turnId: 'turn', ordinal: 0 }
  })
  authority.readPreparationEvidence = () => null
  await expect(
    finalizeConversationDeliveryReceipt(fixture.host.db, plan.planId, authority, signal)
  ).rejects.toThrow('unverified')
})
it('invalidates a completed receipt if origin authority changes', async () => {
  bind()
  await journal.resolveDispatch({
    clientMessageId: 'trigger',
    fence: 1,
    state: 'accepted',
    originCorrelation: 'exact',
    providerIdentity: { provider: 'codex', threadId: 'native-thread', turnId: 'turn', ordinal: 0 }
  })
  const receipt = await finalizeConversationDeliveryReceipt(
    fixture.host.db,
    plan.planId,
    authority,
    signal
  )
  if (!receipt) {
    throw new Error('missing receipt')
  }
  fixture.host.db
    .prepare('DELETE FROM conversation_origin_rows WHERE session_id=?')
    .run('session-b')
  expect(
    readConversationDeliveryReceipt(fixture.host.db, receipt.deliveryReceiptId, authority)
  ).toBeNull()
})

it('refuses a candidate submission that is not the durably reserved delivery', () => {
  fixture.host.db.prepare('DELETE FROM conversation_trigger_reservations').run()
  expect(bind).toThrow('reserved delivery')
})
it('refuses native input after the switch has been cancelled', () => {
  fixture.host.db
    .prepare(
      "UPDATE conversation_switch_intents SET record_json=json_set(record_json,'$.phase','cancelled') WHERE operation_key=?"
    )
    .run(fixture.operationKey)
  fixture.host.db
    .prepare(
      "UPDATE conversations SET record_json=json_set(record_json,'$.pendingOperationKey',null)"
    )
    .run()
  expect(bind).toThrow('pending')
})
it('refuses legacy content-matched acceptance without exact causal correlation', async () => {
  bind()
  await journal.resolveDispatch({
    clientMessageId: 'trigger',
    fence: 1,
    state: 'accepted',
    providerIdentity: { provider: 'codex', threadId: 'native-thread', turnId: 'turn', ordinal: 0 }
  })
  expect(
    await finalizeConversationDeliveryReceipt(fixture.host.db, plan.planId, authority, signal)
  ).toBeNull()
})
it('invalidates acceptance when prior coverage changes independently of source authority', async () => {
  bind()
  await journal.resolveDispatch({
    clientMessageId: 'trigger',
    fence: 1,
    state: 'accepted',
    originCorrelation: 'exact',
    providerIdentity: { provider: 'codex', threadId: 'native-thread', turnId: 'turn', ordinal: 0 }
  })
  const receipt = await finalizeConversationDeliveryReceipt(
    fixture.host.db,
    plan.planId,
    authority,
    signal
  )
  if (!receipt) {
    throw new Error('missing receipt')
  }
  fixture.host.db
    .prepare('UPDATE conversation_context_coverage_revision SET revision=revision+1 WHERE id=1')
    .run()
  expect(
    readConversationDeliveryReceipt(fixture.host.db, receipt.deliveryReceiptId, authority)
  ).toBeNull()
})

it('does not accept a different submission as the reserved trigger', async () => {
  bind()
  await journal.appendSubmission({
    clientMessageId: 'other',
    payloadFingerprint: 'other-fp',
    fence: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'other' }] }
  })
  await journal.resolveDispatch({
    clientMessageId: 'other',
    fence: 1,
    state: 'accepted',
    originCorrelation: 'exact',
    providerIdentity: {
      provider: 'codex',
      threadId: 'native-thread',
      turnId: 'other-turn',
      ordinal: 0
    }
  })
  expect(journal.receiptFor('other')?.originCorrelation).toBe('exact')
  expect(
    await finalizeConversationDeliveryReceipt(fixture.host.db, plan.planId, authority, signal)
  ).toBeNull()
  expect(bind).toThrow('reconcile before replay')
})
