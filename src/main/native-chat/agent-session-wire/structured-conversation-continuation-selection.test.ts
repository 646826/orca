import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { foundAgentSessionRecord } from '../../runtime/agent-session-record-founding'
import { conversationContinuationTransferId } from './structured-conversation-continuation'
import { expect, it } from 'vitest'
import { nextConversationContinuationDraft } from './structured-conversation-continuation-selection'
import { triggerClaimsFixture } from '../conversations/conversation-trigger-claims.test-fixture'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { hostTestMessage, HOST_TEST_NOW } from './structured-agent-session-host-test-data'

it('releases an A draft after A to B to C, excludes old generations and preserves per-source order', async () => {
  const f = await triggerClaimsFixture()
  const sourceId = f.request.queueSessionId
  f.db
    .prepare(
      "UPDATE conversation_participants SET record_json=json_set(record_json,'$.state','parked') WHERE session_id=?"
    )
    .run(sourceId)
  await f.source.queuedMessages.hold({ messageIds: [f.draft.messageId], reason: 'send_failed' })
  const participant = f.db
    .prepare('SELECT record_json FROM conversation_participants WHERE session_id=?')
    .get(sourceId)!
  f.db
    .prepare(
      "INSERT INTO conversation_participants(session_id,conversation_id,record_json) VALUES(?,?,json_set(?,'$.sessionId',?,'$.state','parked'))"
    )
    .run('parked-b', f.intent.conversationId, participant.record_json, 'parked-b')
  const record = f.store.getRecord(sourceId)
  if (!record) {
    throw new Error('source record missing')
  }
  f.db
    .prepare('INSERT INTO agent_session_records(session_id,record_json) VALUES(?,?)')
    .run(
      'parked-b',
      JSON.stringify(
        foundAgentSessionRecord(
          { ...record, sessionId: 'parked-b' },
          { claimKeyId: 'parked-b', now: 1 }
        )
      )
    )
  const parked = await openAgentSessionJournal({
    database: f.host.deps.journalDatabase,
    identity: {
      sessionId: 'parked-b',
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'codex',
      providerHandle: null
    },
    now: () => HOST_TEST_NOW + 1
  })
  await parked.queuedMessages.insert({ messageId: 'b-draft', body: hostTestMessage('B') })
  const getJournal = (id: string) =>
    id === sourceId ? f.source : id === 'parked-b' ? parked : null
  const input = {
    conversationId: f.intent.conversationId,
    contextGeneration: 1,
    targetSessionId: 'c'
  }
  expect(nextConversationContinuationDraft(f.db, input, getJournal)?.sourceSessionId).toBe(
    'parked-b'
  )
  await f.source.queuedMessages.withdraw([f.draft.messageId])
  await f.source.queuedMessages.insert({ messageId: 'a-first', body: hostTestMessage('A first') })
  await f.source.queuedMessages.insert({ messageId: 'a-second', body: hostTestMessage('A second') })
  expect(nextConversationContinuationDraft(f.db, input, getJournal)?.sourceSessionId).toBe(sourceId)
  expect(nextConversationContinuationDraft(f.db, input, getJournal)?.card.messageId).toBe('a-first')
  f.db
    .prepare(
      "UPDATE conversation_participants SET record_json=json_set(record_json,'$.contextGeneration',2) WHERE session_id=?"
    )
    .run(sourceId)
  expect(nextConversationContinuationDraft(f.db, input, getJournal)?.sourceSessionId).toBe(
    'parked-b'
  )
  f.db
    .prepare(
      "UPDATE conversation_participants SET record_json=json_set(record_json,'$.contextGeneration',1) WHERE session_id=?"
    )
    .run(sourceId)
  const first = f.source.queuedMessages.get('a-first')!
  const fence = f.store.getRecord(sourceId)!.lease.runtimeFence
  await f.source.appendSubmission(
    {
      clientMessageId: 'a-attempt',
      payloadFingerprint: first.fingerprint,
      body: first.body,
      fence
    },
    { messageId: first.messageId, expect: 'waiting' }
  )
  await f.source.resolveDispatch({
    clientMessageId: 'a-attempt',
    state: 'pending',
    turnScope: { kind: 'thread' },
    fence
  })
  await f.source.resolveDispatch({
    clientMessageId: 'a-attempt',
    state: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact('providerRejected'), {
      surface: 'rejection'
    }),
    fence
  })
  expect(f.source.queuedMessages.get('a-first')?.state).toBe('returned')
  expect(nextConversationContinuationDraft(f.db, input, getJournal)?.sourceSessionId).toBe(
    'parked-b'
  )
  await parked.close()
})

it('uses precise draft origin despite archived generations and refuses missing legacy proof', async () => {
  const f = await triggerClaimsFixture()
  const sourceId = f.request.queueSessionId
  f.db
    .prepare(
      "UPDATE conversation_participants SET record_json=json_set(record_json,'$.state','parked') WHERE session_id=?"
    )
    .run(sourceId)
  const sourceSegment = f.store.conversations
    .segments(f.intent.conversationId)
    .find((segment) => segment.sessionId === sourceId)!
  f.db
    .prepare(
      'INSERT INTO conversation_segments(segment_id,conversation_id,ordinal,record_json) VALUES(?,?,?,?)'
    )
    .run(
      'previous-context',
      f.intent.conversationId,
      99,
      JSON.stringify({
        ...sourceSegment,
        segmentId: 'previous-context',
        ordinal: 99,
        contextGeneration: 2
      })
    )
  expect(
    nextConversationContinuationDraft(f.db, { ...f.intent }, f.deliveryHost.getJournal)
      ?.sourceSessionId
  ).toBe(sourceId)
  f.db.prepare('DELETE FROM queued_message_origins WHERE session_id=?').run(sourceId)
  expect(() =>
    nextConversationContinuationDraft(f.db, { ...f.intent }, f.deliveryHost.getJournal)
  ).toThrow('stale-generation')
  expect(f.source.queuedMessages.list()[0]?.state).toBe('waiting')
})

it('keeps identical message IDs from different source queues as separate transfer identities', () => {
  const a = conversationContinuationTransferId('operation', { sessionId: 'a', messageId: 'same' })
  const b = conversationContinuationTransferId('operation', {
    sessionId: 'parked-b',
    messageId: 'same'
  })
  expect(a).not.toBe(b)
  expect(
    conversationContinuationTransferId('operation', { sessionId: 'a', messageId: 'same' })
  ).toBe(a)
})
