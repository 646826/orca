import { expect, it } from 'vitest'
import { CALLER } from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION,
  HOST_TEST_NOW,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { createCodexConversationRoundtripFixture } from './structured-conversation-roundtrip.test-fixture'
import type { ConversationSwitchIntent } from '../../../shared/conversation-record'
import {
  assertConversationPendingNativePublished,
  readConversationFreshNativeProof
} from '../conversations/conversation-pending-native-identity'

it('retains verified first publication through native A → B → A → B without treating it as fresh', async () => {
  const f = await createCodexConversationRoundtripFixture()
  const { host, db, signal, targetId } = f
  const activate = async (intent: ConversationSwitchIntent, source: string, target: string) => {
    expect(await f.send(source, 'Preserve the earlier decision.', true)).toMatchObject({ ok: true })
    f.approve(host.deps.store.conversations.intent(intent.operationKey)!)
    expect(await host.advanceConversationSwitch(intent.operationKey, signal)).toEqual({
      kind: 'waiting-consent'
    })
    f.consent(intent)
    const pending = host.advanceConversationSwitch(intent.operationKey, signal)
    await f.acceptNative(target, `Native response from ${target}.`)
    expect(await pending).toMatchObject({ kind: 'activated' })
  }
  try {
    await f.enrollSource()
    const initial = f.send(HOST_TEST_SESSION, 'Never upload private files.')
    await f.acceptNative(HOST_TEST_SESSION, 'Initial native response.')
    expect(await initial).toMatchObject({ ok: true })
    const first = await f.foundTarget(HOST_TEST_SESSION, targetId, {
      options: { model: 'gpt-live' }
    })
    await expect(host.advanceConversationSwitch(first.operationKey, signal)).rejects.toThrow(
      'Candidate native acquisition refused'
    )
    const trust = host.deps.conversationEvidenceTrust!.read(first.operationKey)!
    host.deps.conversationEvidenceTrust!.approve(
      { operationKey: first.operationKey, choiceDigest: trust.choiceDigest },
      CALLER.callerKey
    )
    expect(await host.advanceConversationSwitch(first.operationKey, signal)).toMatchObject({
      kind: 'blocked',
      reasons: ['recipient-approval-required']
    })
    await activate(first, HOST_TEST_SESSION, targetId)
    const firstPublication = db
      .prepare('SELECT * FROM conversation_pending_native_identity WHERE session_id=?')
      .get(targetId)
    expect(firstPublication?.native_identity).toEqual(expect.any(String))
    expect(firstPublication?.effect_seen).toBe(0)
    await activate(await f.beginReturn(targetId, HOST_TEST_SESSION), targetId, HOST_TEST_SESSION)
    const revisit = await f.beginReturn(HOST_TEST_SESSION, targetId)
    expect(revisit.candidateSegmentId).not.toBe(first.candidateSegmentId)
    expect(host.deps.store.conversations.intent(first.operationKey)?.phase).toBe('activated')
    expect(host.deps.store.getRecord(targetId)?.lease).toMatchObject({
      claimStatus: 'live',
      runtimeFence: firstPublication?.fence
    })
    expect(
      db
        .prepare('SELECT * FROM conversation_pending_native_identity WHERE session_id=?')
        .get(targetId)
    ).toEqual(firstPublication)
    expect(
      readConversationFreshNativeProof(db, {
        sessionId: targetId,
        operationKey: first.operationKey
      })
    ).toBeNull()
    await activate(revisit, HOST_TEST_SESSION, targetId)
    expect(f.codex.connections).toHaveLength(2)
    expect(
      f.codex.connections.flatMap((connection) =>
        connection.calls.filter((call) => call.method === 'thread/start')
      )
    ).toHaveLength(2)
    expect(
      host
        .collaboratorsForTests()
        .sessions.get(targetId)!
        .journal.submissions()
        .map((submission) => submission.dispatchState)
    ).toEqual(['accepted', 'accepted'])
    expect(
      db
        .prepare('SELECT * FROM conversation_pending_native_identity WHERE session_id=?')
        .get(targetId)
    ).toEqual(firstPublication)
    if (
      typeof firstPublication?.fence !== 'number' ||
      typeof firstPublication.acquisition_generation !== 'string'
    ) {
      throw new Error('Missing native publication proof')
    }
    const publication = {
      sessionId: targetId,
      fence: firstPublication.fence,
      acquisitionGeneration: firstPublication.acquisition_generation
    }
    const verify = () => assertConversationPendingNativePublished(db, publication)
    expect(verify).not.toThrow()
    expect(() =>
      assertConversationPendingNativePublished(db, { ...publication, fence: publication.fence + 1 })
    ).toThrow('pending native publication unverified')
    expect(() =>
      assertConversationPendingNativePublished(db, {
        ...publication,
        acquisitionGeneration: 'foreign'
      })
    ).toThrow('pending native publication unverified')
    const faults = [
      "UPDATE conversation_pending_native_identity SET native_identity='changed' WHERE session_id=?",
      "UPDATE conversation_pending_native_identity SET process_digest='changed' WHERE session_id=?",
      "UPDATE conversation_pending_native_identity SET acquisition_generation='foreign' WHERE session_id=?",
      "UPDATE conversation_pending_native_identity SET scope_digest='changed' WHERE session_id=?",
      'UPDATE conversation_pending_native_identity SET effect_seen=1 WHERE session_id=?',
      'UPDATE conversation_pending_native_identity SET link_json=NULL WHERE session_id=?',
      "UPDATE conversation_pending_native_identity SET link_json='{}' WHERE session_id=?",
      "UPDATE conversation_origin_acquisitions SET native_identity='changed' WHERE session_id=?",
      "UPDATE conversation_origin_acquisitions SET origin_json=json_set(origin_json,'$.segmentId','foreign') WHERE session_id=?",
      "UPDATE agent_session_records SET record_json=json_set(record_json,'$.lease.ownerProcess.pid',999999) WHERE session_id=?",
      "UPDATE agent_session_records SET record_json=json_set(record_json,'$.lease.runtimeFence',999999,'$.providerHandleChain[0].mintedAtFence',999999) WHERE session_id=?",
      "UPDATE conversation_participants SET record_json=json_set(record_json,'$.nativeBindingGeneration',999999) WHERE session_id=?",
      "UPDATE conversation_participants SET record_json=json_set(record_json,'$.contextGeneration',999999) WHERE session_id=?"
    ]
    for (const fault of faults) {
      db.exec('SAVEPOINT invalid_publication')
      try {
        expect(db.prepare(fault).run(targetId).changes).toBeGreaterThan(0)
        expect(verify, fault).toThrow('pending native publication unverified')
      } finally {
        db.exec('ROLLBACK TO invalid_publication; RELEASE invalid_publication')
      }
      expect(verify).not.toThrow()
    }
    const receipt = host.deps.store.conversations.intent(first.operationKey)!.deliveryReceiptId!
    const activationFaults = [
      [
        "UPDATE conversation_switch_intents SET record_json=json_set(record_json,'$.phase','cancelled') WHERE operation_key=?",
        first.operationKey
      ],
      [
        "UPDATE conversation_switch_intents SET record_json=json_set(record_json,'$.candidateSegmentId','foreign') WHERE operation_key=?",
        first.operationKey
      ],
      [
        "UPDATE conversation_switch_intents SET record_json=json_set(record_json,'$.deliveryReceiptId',?) WHERE operation_key=?",
        host.deps.store.conversations.intent(revisit.operationKey)!.deliveryReceiptId!,
        first.operationKey
      ],
      ['DELETE FROM conversation_delivery_receipts WHERE receipt_id=?', receipt]
    ]
    for (const [fault, ...parameters] of activationFaults) {
      db.exec('SAVEPOINT invalid_activation')
      try {
        expect(db.prepare(fault!).run(...parameters).changes).toBeGreaterThan(0)
        expect(verify, fault).toThrow('pending native publication unverified')
      } finally {
        db.exec('ROLLBACK TO invalid_activation; RELEASE invalid_activation')
      }
      expect(verify).not.toThrow()
    }
    const conversation = host.deps.store.conversations.read(first.conversationId)!
    const clear = await host.deps.store.conversations.clear.begin(
      {
        conversationId: conversation.conversationId,
        expectedRevision: conversation.revision,
        expectedContextGeneration: conversation.contextGeneration,
        expectedActivationFence: conversation.activationFence
      },
      {
        callerKey: CALLER.callerKey,
        operationId: hostTestOperationId(),
        fingerprint: 'clear-published-revisit',
        now: HOST_TEST_NOW
      }
    )
    expect(await host.advanceConversationClear(clear.intent!.operationKey, signal)).toEqual({
      kind: 'committed'
    })
    expect(host.deps.store.conversations.read(first.conversationId)?.contextGeneration).toBe(
      conversation.contextGeneration + 1
    )
    expect(verify).toThrow('pending native publication unverified')
  } finally {
    await f.close()
  }
}, 60_000)
