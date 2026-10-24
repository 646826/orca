import { expect, it } from 'vitest'
import { runJournalTransaction } from '../agent-session-journal/journal-database'
import { readPinnedQueuedMessageEvidence } from '../agent-session-journal/queued-message-origin'
import { appendConversationTransfer } from '../agent-session-wire/structured-conversation-source-queue'
import { hostTestMessage } from '../agent-session-wire/structured-agent-session-host-test-data'
import { triggerClaimsFixture } from './conversation-trigger-claims.test-fixture'
import { prepareConversationTrigger } from './conversation-trigger-claims'
import {
  reserveConversationTrigger,
  readConversationTrigger,
  conversationTriggerAppendReceipt,
  canDispatchConversationTransfer
} from './conversation-trigger-reservation'

async function prepared() {
  const f = await triggerClaimsFixture()
  f.host.stopDelivery()
  const trigger = await prepareConversationTrigger(
    f.db,
    f.request,
    f.claimsHost,
    1,
    new AbortController().signal
  )
  const target = f.deliveryHost.getJournal(f.targetId)!
  const append = () =>
    appendConversationTransfer({
      db: f.db,
      source: f.source,
      target,
      binding: trigger.binding,
      authority: trigger.authority,
      body: trigger.body,
      options: trigger.options,
      fence: f.store.getRecord(f.targetId)!.lease.runtimeFence,
      now: 1,
      isCurrent: (journal) =>
        f.deliveryHost.getJournal(journal.queuedMessages.sessionId) === journal
    })
  return { ...f, ...trigger, target, append }
}

it('refuses a trigger without durable switch and manifest authority', async () => {
  const f = await prepared()
  expect(() =>
    runJournalTransaction(f.db, () =>
      reserveConversationTrigger(
        f.db,
        { ...f.binding, operationKey: 'missing', transferId: 'missing' },
        f.authority
      )
    )
  ).toThrow('authority changed')
})

it('reserves once, freezes journal edits/withdrawals, and refuses a different trigger identity', async () => {
  const f = await prepared()
  expect(
    runJournalTransaction(f.db, () => reserveConversationTrigger(f.db, f.binding, f.authority))
  ).toEqual({ binding: f.binding, state: 'reserved' })
  await expect(
    f.source.queuedMessages.update({
      messageId: f.draft.messageId,
      expectedBodyFingerprint: f.draft.fingerprint,
      text: 'edited after reservation'
    })
  ).rejects.toThrow('reserved')
  await expect(f.source.queuedMessages.withdraw([f.draft.messageId])).rejects.toThrow('reserved')
  expect(() =>
    runJournalTransaction(f.db, () =>
      reserveConversationTrigger(f.db, { ...f.binding, targetSubmissionId: 'second' }, f.authority)
    )
  ).toThrow('identity conflict')
  expect(f.source.queuedMessages.get(f.draft.messageId)?.body).toEqual(f.draft.body)
})

it('refuses a target-only receipt without source withdrawal, then commits and replays the compound once', async () => {
  const f = await prepared()
  const before = f.target.cursor()
  await expect(
    f.target.appendSubmission(
      {
        clientMessageId: f.binding.targetSubmissionId,
        payloadFingerprint: f.binding.targetFingerprint,
        body: f.body,
        options: f.options,
        fence: f.store.getRecord(f.targetId)!.lease.runtimeFence,
        handoverRecorded: true
      },
      undefined,
      conversationTriggerAppendReceipt({
        binding: f.binding,
        originSessionId: f.targetId,
        authority: f.authority,
        now: 1,
        sourceWithdrawal: { epoch: f.source.epoch, sequence: f.source.cursor().sequence + 1 }
      })
    )
  ).rejects.toThrow('source withdrawal missing')
  expect(f.target.cursor()).toEqual(before)
  expect(f.source.queuedMessages.get(f.draft.messageId)?.state).toBe('waiting')
  expect(readConversationTrigger(f.db, f.intent.operationKey)?.state).toBe('reserved')
  await f.append()
  const committed = f.target.cursor()
  await f.append()
  expect(f.target.cursor()).toEqual(committed)
  expect(f.source.queuedMessages.get(f.draft.messageId)).toMatchObject({
    state: 'withdrawn',
    consumedAs: null
  })
  expect(f.target.submission(f.binding.targetSubmissionId)?.queuedMessageId).toBeUndefined()
  expect(f.binding.sourceFingerprint).not.toBe(f.binding.targetFingerprint)
})

it('retains the exact transferred original when source rollover drops its withdrawn live card', async () => {
  const f = await prepared()
  const proofInput = {
    ownerId: `conversation-transfer:${f.binding.transferId}`,
    sourceSessionId: f.binding.queueSessionId,
    messageId: f.binding.messageId,
    fingerprint: f.binding.sourceFingerprint
  }
  const proof = readPinnedQueuedMessageEvidence(f.db, proofInput)
  await f.append()
  await f.source.rollEpoch(
    'session_created',
    f.store.getRecord(f.binding.queueSessionId)!.lease.runtimeFence
  )
  expect(f.source.queuedMessages.get(f.draft.messageId)).toBeNull()
  expect(readPinnedQueuedMessageEvidence(f.db, proofInput)).toEqual(proof)
  expect(
    runJournalTransaction(f.db, () =>
      canDispatchConversationTransfer(
        f.db,
        {
          transferId: f.binding.transferId,
          targetSessionId: f.targetId,
          targetSubmissionId: f.binding.targetSubmissionId
        },
        { ...f.authority, verifyTriggerClaims: () => false }
      )
    )
  ).toBe(false)
})

it('requires committed active-generation acceptance before reserving separate queued continuations', async () => {
  const f = await triggerClaimsFixture()
  f.host.stopDelivery()
  const signal = new AbortController().signal
  const request = { ...f.request, kind: 'queued-continuation' as const }
  await expect(prepareConversationTrigger(f.db, request, f.claimsHost, 1, signal)).rejects.toThrow()
  const candidate = f.intent.candidateSegmentId!
  const evidence = {
    deliveryReceiptId: 'committed-acceptance',
    operationKey: f.intent.operationKey,
    manifestId: f.manifest.manifestId,
    targetSessionId: f.targetId,
    contextGeneration: 1,
    activationFence: f.intent.activationFence,
    nativeBindingGeneration: f.intent.nativeBindingGeneration,
    sourceBoundaries: f.intent.sourceBoundaries,
    candidateBoundary: {
      sessionId: f.targetId,
      epoch: f.deliveryHost.getJournal(f.targetId)!.epoch,
      endSequence: 1
    },
    candidateBaseline: [],
    candidateReadback: []
  }
  f.db
    .prepare(
      `UPDATE conversation_switch_intents SET record_json=json_set(record_json,'$.phase','activated','$.deliveryReceiptId',?) WHERE operation_key=?`
    )
    .run(evidence.deliveryReceiptId, f.intent.operationKey)
  f.db
    .prepare(
      `UPDATE conversations SET record_json=json_set(record_json,'$.pendingOperationKey',NULL,'$.activeSegmentId',?,'$.activationFence',?) WHERE conversation_id=?`
    )
    .run(candidate, f.intent.activationFence, f.intent.conversationId)
  f.db
    .prepare(
      `UPDATE conversation_segments SET record_json=json_set(record_json,'$.lifecycle','activated') WHERE segment_id=?`
    )
    .run(candidate)
  f.db
    .prepare(
      `UPDATE conversation_participants SET record_json=json_set(record_json,'$.state','active') WHERE session_id=?`
    )
    .run(f.targetId)
  await expect(prepareConversationTrigger(f.db, request, f.claimsHost, 1, signal)).rejects.toThrow(
    'receipt'
  )
  f.db
    .prepare('INSERT INTO conversation_delivery_receipts VALUES(?,?,?,?,?)')
    .run(evidence.deliveryReceiptId, f.plan.planId, -1, -1, JSON.stringify(evidence))
  const first = await prepareConversationTrigger(f.db, request, f.claimsHost, 1, signal)
  const second = await f.source.queuedMessages.insert({
    messageId: 'second-draft',
    body: hostTestMessage('later intention')
  })
  const next = await prepareConversationTrigger(
    f.db,
    {
      ...request,
      transferId: 'second-transfer',
      messageId: second.messageId,
      targetSubmissionId: 'second-target'
    },
    f.claimsHost,
    1,
    signal
  )
  expect(first.binding.transferId).not.toBe(next.binding.transferId)
  f.db
    .prepare(
      `UPDATE conversations SET record_json=json_set(record_json,'$.contextGeneration',2) WHERE conversation_id=?`
    )
    .run(f.intent.conversationId)
  expect(() =>
    runJournalTransaction(f.db, () =>
      reserveConversationTrigger(f.db, next.binding, next.authority)
    )
  ).toThrow('generation')
})

it.each(['uncertain', 'accepted', 'proven-no-effect'] as const)(
  'preserves historical %s proof without authorizing another dispatch',
  async (state) => {
    const f = await prepared()
    await f.append()
    f.db
      .prepare('UPDATE conversation_trigger_reservations SET state=? WHERE transfer_id=?')
      .run(state, f.binding.transferId)
    expect(readConversationTrigger(f.db, f.intent.operationKey)).toEqual({
      binding: f.binding,
      state
    })
    expect(
      runJournalTransaction(f.db, () =>
        canDispatchConversationTransfer(
          f.db,
          {
            transferId: f.binding.transferId,
            targetSessionId: f.targetId,
            targetSubmissionId: f.binding.targetSubmissionId
          },
          f.authority
        )
      )
    ).toBe(false)
    expect(f.source.queuedMessages.get(f.draft.messageId)?.state).toBe('withdrawn')
  }
)

it('refuses a source participant from another generation before content authority', async () => {
  const f = await prepared()
  f.db
    .prepare(
      `UPDATE conversation_participants SET record_json=json_set(record_json,'$.contextGeneration',2) WHERE session_id=?`
    )
    .run(f.binding.queueSessionId)
  expect(() =>
    runJournalTransaction(f.db, () => reserveConversationTrigger(f.db, f.binding, f.authority))
  ).toThrow('source scope changed')
})
