import { expect, it } from 'vitest'
import { AgentSessionPreDispatchError } from '../agent-session-wire/structured-agent-session-operation-settlement'
import { PROVIDER_SESSION_ID } from '../../claude/claude-structured-session-test-support'
import {
  noWriteFixture as fixture,
  refusedNoWriteFixture as refusedFixture
} from './conversation-transfer-no-write.fixture'
import { readHistoricalConversationTransferNoWrite } from './conversation-transfer-no-write'

it('durably proves a real final refusal after options changed without inventing a queued target', async () => {
  const f = await fixture()
  f.host.deps.bindConversationEvidencePlan = async () => {
    throw new AgentSessionPreDispatchError('candidate-context-unverified')
  }
  await f.handover()
  expect(f.claude.connections[0]?.calls).toContainEqual({
    subtype: 'apply_flag_settings',
    params: { settings: { effortLevel: 'high' } }
  })
  expect(f.claude.connections[0]?.sent).toEqual([])
  const submission = f.journal.submission(f.request.targetSubmissionId)
  expect(submission).toMatchObject({ dispatchState: 'rejected' })
  expect(submission?.queuedMessageId).toBeUndefined()
  expect(submission?.rejection).not.toHaveProperty('neverReachedAgent')
  expect(f.proof()).toMatchObject({
    targetSubmissionId: f.request.targetSubmissionId,
    runtimeFence: f.acquisition.fence,
    recoveryAttempt: 0,
    reason: 'pre-dispatch-refusal'
  })
})

it('does not turn a real adapter postwrite cancellation into no-write evidence', async () => {
  const f = await fixture()
  const connection = f.claude.connections[0]!
  const reason = new Error('stopped after wire write')
  connection.send = async (message, beforeWrite) => {
    await beforeWrite?.()
    connection.sent.push(message)
    f.aborts.abort(f.targetId, reason)
    throw reason
  }
  await f.handover()
  expect(connection.sent).toHaveLength(1)
  expect(f.journal.submission(f.request.targetSubmissionId)?.dispatchState).toBe('unknown')
  expect(f.proof()).toBeNull()
})

it('records Stop during the first actual final observer but never sends the user message', async () => {
  const f = await fixture()
  f.host.deps.bindConversationEvidencePlan = async () => {
    f.aborts.abort(f.targetId, new Error('stopped during observer'))
  }
  await f.handover()
  expect(f.claude.connections[0]?.sent).toEqual([])
  expect(f.proof()).not.toBeNull()
})

it('rolls the rejection and proof back together when the proof insert fails', async () => {
  const f = await refusedFixture()
  f.db.exec(`CREATE TRIGGER fail_no_write BEFORE INSERT ON conversation_transfer_no_write
    BEGIN SELECT RAISE(ABORT,'injected proof failure'); END`)
  await f.handover()
  expect(f.claude.connections[0]?.sent).toEqual([])
  expect(f.journal.submission(f.request.targetSubmissionId)?.dispatchState).toBe('unknown')
  expect(f.proof()).toBeNull()
  expect(
    f.db
      .prepare(`SELECT 1 FROM journal_rows WHERE session_id=?
    AND json_extract(row_json,'$.clientMessageId')=? AND json_extract(row_json,'$.state')='rejected'`)
      .get(f.targetId, f.request.targetSubmissionId)
  ).toBeUndefined()
})

it('makes contradictory durable acceptance beat an earlier no-write proof even when the rejected fold stays terminal', async () => {
  const f = await refusedFixture()
  await f.handover()
  expect(f.proof()).not.toBeNull()
  await f.journal.resolveDispatch({
    clientMessageId: f.request.targetSubmissionId,
    state: 'accepted',
    fence: f.acquisition.fence,
    originCorrelation: 'exact',
    providerIdentity: { provider: 'claude', sessionId: PROVIDER_SESSION_ID, uuid: 'late-accepted' }
  })
  expect(f.journal.submission(f.request.targetSubmissionId)?.dispatchState).toBe('rejected')
  expect(f.proof()).toBeNull()
})

it.each(['context', 'native', 'fence'] as const)(
  'refuses an old proof after %s authority changes',
  async (change) => {
    const f = await refusedFixture()
    await f.handover()
    expect(f.proof()).not.toBeNull()
    if (change === 'context') {
      f.db
        .prepare(`UPDATE conversations
    SET record_json=json_set(record_json,'$.contextGeneration',2) WHERE conversation_id=?`)
        .run(f.intent.conversationId)
    }
    if (change === 'native') {
      f.db
        .prepare(`UPDATE agent_session_records
    SET record_json=json_set(record_json,'$.accountHome.path','/different-account') WHERE session_id=?`)
        .run(f.targetId)
    }
    if (change === 'fence') {
      f.db
        .prepare(`UPDATE agent_session_records
    SET record_json=json_set(record_json,'$.lease.runtimeFence',99) WHERE session_id=?`)
        .run(f.targetId)
    }
    expect(f.proof()).toBeNull()
    expect(
      f.db
        .prepare('SELECT 1 FROM conversation_transfer_no_write WHERE transfer_id=?')
        .get(f.request.transferId)
    ).toBeDefined()
  }
)

it('retains historical no-write evidence across owner release without treating it as current permission', async () => {
  const f = await refusedFixture()
  await f.handover()
  const proof = f.proof()
  f.db
    .prepare(`UPDATE agent_session_records SET record_json=json_set(record_json,
    '$.lease.runtimeFence',99,'$.lease.claimStatus','released','$.lease.unreconciled',json('true'))
    WHERE session_id=?`)
    .run(f.targetId)
  expect(f.proof()).toBeNull()
  expect(readHistoricalConversationTransferNoWrite(f.db, f.request.transferId)).toEqual(proof)
})

it('keeps a recovering live lease historical-only instead of treating it as current writer authority', async () => {
  const f = await refusedFixture()
  await f.handover()
  const proof = f.proof()
  expect(proof).not.toBeNull()
  f.db
    .prepare(`UPDATE agent_session_records SET record_json=json_set(record_json,
    '$.lease.handoffStage','recovering') WHERE session_id=?`)
    .run(f.targetId)
  expect(f.proof()).toBeNull()
  expect(readHistoricalConversationTransferNoWrite(f.db, f.request.transferId)).toEqual(proof)
})

it.each([
  'birth',
  'account',
  'native',
  'context',
  'pin',
  'source-birth',
  'source-native-generation'
] as const)('rejects historical recovery evidence after %s changes', async (change) => {
  const f = await refusedFixture()
  await f.handover()
  expect(readHistoricalConversationTransferNoWrite(f.db, f.request.transferId)).not.toBeNull()
  if (change === 'source-birth') {
    f.db
      .prepare(`UPDATE agent_session_records SET record_json=json_set(record_json,'$.createdAt',1234567)
        WHERE session_id=?`)
      .run(f.request.queueSessionId)
  } else if (change === 'source-native-generation') {
    f.db
      .prepare(`UPDATE conversation_participants SET record_json=json_set(record_json,'$.nativeBindingGeneration',99)
        WHERE session_id=?`)
      .run(f.request.queueSessionId)
  } else if (change === 'pin') {
    f.db
      .prepare('DELETE FROM journal_epoch_pins WHERE owner_id=?')
      .run(`conversation-no-write:${f.request.transferId}:0`)
  } else if (change === 'context') {
    f.db
      .prepare(`UPDATE conversations SET record_json=json_set(record_json,'$.contextGeneration',2)
      WHERE conversation_id=?`)
      .run(f.intent.conversationId)
  } else {
    const path =
      change === 'birth'
        ? '$.createdAt'
        : change === 'account'
          ? '$.accountHome.path'
          : '$.providerHandleChain[0].handle.nativeId'
    f.db
      .prepare(
        'UPDATE agent_session_records SET record_json=json_set(record_json,?,?) WHERE session_id=?'
      )
      .run(path, change === 'birth' ? 1234567 : 'changed-identity', f.targetId)
  }
  expect(readHistoricalConversationTransferNoWrite(f.db, f.request.transferId)).toBeNull()
})

it('verifies a pinned rejected attempt through actual journal replacement and rejects a later target attempt', async () => {
  const f = await refusedFixture()
  await f.handover()
  const proof = f.proof()
  await f.journal.replaceEpochItems('legacy_import', f.acquisition.fence, [])
  expect(f.proof()).toBeNull()
  expect(readHistoricalConversationTransferNoWrite(f.db, f.request.transferId)).toEqual(proof)
  await f.journal.resolveDispatch({
    clientMessageId: f.request.targetSubmissionId,
    state: 'accepted',
    providerIdentity: null,
    fence: f.acquisition.fence
  })
  expect(readHistoricalConversationTransferNoWrite(f.db, f.request.transferId)).toBeNull()
})

it('fails closed before scanning an oversized proof window without discarding the durable original', async () => {
  const f = await refusedFixture()
  await f.handover()
  const proof = f.proof()!
  const row = f.db
    .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?')
    .get(f.targetId, proof.targetEpoch, proof.rejectionSequence)!
  const extra = { ...JSON.parse(String(row.row_json)), seq: proof.targetSubmissionSequence + 4096 }
  f.db
    .prepare('INSERT INTO journal_rows(session_id,epoch,seq,ts,row_json) VALUES(?,?,?,?,?)')
    .run(f.targetId, proof.targetEpoch, extra.seq, extra.ts, JSON.stringify(extra))
  expect(f.proof()).toBeNull()
  expect(readHistoricalConversationTransferNoWrite(f.db, f.request.transferId)).toBeNull()
  expect(
    f.db
      .prepare('SELECT 1 FROM conversation_transfer_no_write WHERE transfer_id=?')
      .get(f.request.transferId)
  ).toBeDefined()
})

it('proves a short refusal after a long pre-existing target epoch and retains its exact rows through replacement', async () => {
  const f = await refusedFixture()
  await f.journal.replaceEpochItems(
    'legacy_import',
    f.acquisition.fence,
    Array.from({ length: 4100 }, (_, n) => ({
      identity: { provider: 'claude' as const, sessionId: PROVIDER_SESSION_ID, uuid: `old-${n}` },
      body: {
        kind: 'message' as const,
        role: 'assistant' as const,
        blocks: [{ type: 'text' as const, text: 'old unrelated history' }]
      },
      ownerFence: f.acquisition.fence
    }))
  )
  await f.handover()
  const proof = f.proof()
  expect(proof?.targetSubmissionSequence).toBeGreaterThan(4096)
  expect(proof?.rejectionSequence).toBeLessThan(proof!.targetSubmissionSequence + 10)
  expect(
    f.db
      .prepare('SELECT end_sequence FROM journal_epoch_pins WHERE owner_id=?')
      .get(`conversation-no-write:${f.request.transferId}:0`)?.end_sequence
  ).toBe(1)
  await f.journal.replaceEpochItems('legacy_import', f.acquisition.fence, [])
  expect(readHistoricalConversationTransferNoWrite(f.db, f.request.transferId)).toEqual(proof)
  expect(f.claude.connections[0]?.sent).toEqual([])
})

it('refuses an interior gap in newer replacement history rather than assuming missing acceptance never happened', async () => {
  const f = await refusedFixture()
  await f.handover()
  await f.journal.replaceEpochItems(
    'legacy_import',
    f.acquisition.fence,
    [0, 1].map((n) => ({
      identity: {
        provider: 'claude' as const,
        sessionId: PROVIDER_SESSION_ID,
        uuid: `replacement-${n}`
      },
      body: {
        kind: 'message' as const,
        role: 'assistant' as const,
        blocks: [{ type: 'text' as const, text: 'retained history' }]
      },
      ownerFence: f.acquisition.fence
    }))
  )
  expect(readHistoricalConversationTransferNoWrite(f.db, f.request.transferId)).not.toBeNull()
  f.db
    .prepare('DELETE FROM journal_epoch_pins WHERE session_id=? AND epoch=?')
    .run(f.targetId, f.journal.epoch)
  f.db
    .prepare('DELETE FROM journal_rows WHERE session_id=? AND epoch=? AND seq=2')
    .run(f.targetId, f.journal.epoch)
  expect(readHistoricalConversationTransferNoWrite(f.db, f.request.transferId)).toBeNull()
})
