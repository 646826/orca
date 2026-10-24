import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { expect, it } from 'vitest'
import { createConversationSwitchFixture } from '../conversations/conversation-switch.fixture'
import { createConversationOriginRowHook } from '../conversations/conversation-origin-rows'
import { AgentSessionJournal } from './journal-store'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { assertQueuedDraftCurrentGeneration } from './queued-message-origin'

async function open(
  f: Awaited<ReturnType<typeof createConversationSwitchFixture>>,
  sessionId = 'session-a'
) {
  const journal = new AgentSessionJournal({
    database: f.host,
    identity: {
      sessionId,
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle(sessionId)
    },
    requiredInTransaction: createConversationOriginRowHook(sessionId),
    now: () => 17
  })
  await journal.open()
  return journal
}
const body = {
  kind: 'message' as const,
  role: 'user' as const,
  blocks: [{ type: 'text' as const, text: 'held original' }]
}

it('rejects old-generation sends and edits without relabeling their origin to the current fence', async () => {
  const f = await createConversationSwitchFixture()
  const journal = await open(f)
  try {
    const old = await journal.queuedMessages.insert({ messageId: 'old', body })
    const before = f.host.db
      .prepare('SELECT origin_json FROM queued_message_origins WHERE message_id=?')
      .get('old')?.origin_json
    f.host.transaction((db) => {
      db.prepare(
        "UPDATE conversations SET record_json=json_set(record_json,'$.contextGeneration',2)"
      ).run()
      db.prepare(
        "UPDATE conversation_participants SET record_json=json_set(record_json,'$.contextGeneration',2)"
      ).run()
    })
    expect(() =>
      journal.queuedMessages.assertConsumable({
        messageId: 'old',
        expect: 'waiting',
        fingerprint: old.fingerprint,
        consumedAs: 'send'
      })
    ).toThrow('stale-generation')
    await expect(
      journal.queuedMessages.update({
        messageId: 'old',
        expectedBodyFingerprint: old.fingerprint,
        text: 'edited'
      })
    ).rejects.toThrow('stale-generation')
    expect(journal.queuedMessages.get('old')?.body).toEqual(body)
    expect(
      f.host.db
        .prepare('SELECT origin_json FROM queued_message_origins WHERE message_id=?')
        .get('old')?.origin_json
    ).toBe(before)
  } finally {
    await journal.close()
    f.close()
  }
})

it('preserves standalone clear intent without relaxing strict transfer origins or later enrollment', async () => {
  const f = await createConversationSwitchFixture()
  const journal = await open(f, 'session-later')
  try {
    await journal.queuedMessages.insert({ messageId: 'unknown', body })
    const original = f.records.getRecord('session-a')!
    f.host.db.prepare('INSERT INTO agent_session_records VALUES(?,?)').run(
      'session-later',
      JSON.stringify({
        ...original,
        sessionId: 'session-later',
        lease: { ...original.lease, sessionId: 'session-later' }
      })
    )
    expect(() =>
      assertQueuedDraftCurrentGeneration(f.host.db, {
        sessionId: 'session-later',
        messageId: 'unknown'
      })
    ).not.toThrow()
    await journal.queuedMessages.insert({ messageId: 'known-unbound', body })
    f.host.db
      .prepare(
        "UPDATE agent_session_records SET record_json=json_set(record_json,'$.providerContextBoundary',json(?)) WHERE session_id=?"
      )
      .run(
        JSON.stringify({
          operationId: 'clear',
          afterFence: original.lease.runtimeFence,
          clearedAt: 19
        }),
        'session-later'
      )
    expect(() =>
      assertQueuedDraftCurrentGeneration(f.host.db, {
        sessionId: 'session-later',
        messageId: 'unknown'
      })
    ).toThrow('stale-generation')
    expect(() =>
      assertQueuedDraftCurrentGeneration(f.host.db, {
        sessionId: 'session-later',
        messageId: 'known-unbound'
      })
    ).toThrow('stale-generation')
    expect(
      f.host.db
        .prepare('SELECT origin_json FROM queued_message_origins WHERE message_id=?')
        .get('unknown')?.origin_json
    ).toBeNull()
    const origins = () =>
      f.host.db
        .prepare('SELECT * FROM queued_message_origins WHERE session_id=? ORDER BY message_id')
        .all('session-later')
    const before = origins()
    const consume = (messageId: string) => {
      const card = journal.queuedMessages.get(messageId)!
      journal.queuedMessages.assertConsumable({
        messageId,
        expect: 'waiting',
        fingerprint: card.fingerprint,
        consumedAs: 'send'
      })
    }
    for (const messageId of ['unknown', 'known-unbound']) {
      expect(() => consume(messageId)).not.toThrow()
      await journal.queuedMessages.update({
        messageId,
        expectedBodyFingerprint: journal.queuedMessages.get(messageId)!.fingerprint,
        text: 'kept edited draft'
      })
      expect(() =>
        assertQueuedDraftCurrentGeneration(f.host.db, { sessionId: 'session-later', messageId })
      ).toThrow('stale-generation')
    }
    expect(origins()).toEqual(before)
    const boundaryRecord = f.host.db
      .prepare('SELECT record_json FROM agent_session_records WHERE session_id=?')
      .get('session-later')!.record_json
    if (typeof boundaryRecord !== 'string') {
      throw new Error('missing boundary record')
    }
    f.host.db.prepare('DELETE FROM agent_session_records WHERE session_id=?').run('session-later')
    expect(() => consume('unknown')).not.toThrow()
    expect(() => consume('known-unbound')).toThrow('stale-generation')
    f.host.db
      .prepare('INSERT INTO agent_session_records VALUES(?,?)')
      .run('session-later', boundaryRecord)
    f.host.db
      .prepare(
        "UPDATE agent_session_records SET record_json=json_set(record_json,'$.accountHome.path','/different-account') WHERE session_id=?"
      )
      .run('session-later')
    expect(() => consume('known-unbound')).toThrow('stale-generation')
    f.host.db
      .prepare('UPDATE agent_session_records SET record_json=? WHERE session_id=?')
      .run(boundaryRecord, 'session-later')
    const records = AgentSessionRecordStore.open({ journalDatabase: f.host, hostId: 'local' })
    await records.conversations.ensureSingleton('session-later')
    for (const messageId of ['unknown', 'known-unbound']) {
      expect(() => consume(messageId)).toThrow('stale-generation')
      await expect(
        journal.queuedMessages.update({
          messageId,
          expectedBodyFingerprint: journal.queuedMessages.get(messageId)!.fingerprint,
          text: 'must not cross enrollment'
        })
      ).rejects.toThrow('stale-generation')
    }
    f.host.db
      .prepare('DELETE FROM conversation_participants WHERE session_id=?')
      .run('session-later')
    expect(() => consume('unknown')).toThrow('stale-generation')
    expect(() => consume('known-unbound')).toThrow('stale-generation')
    expect(origins()).toEqual(before)
  } finally {
    await journal.close()
    f.close()
  }
})

it('preserves admission origin through ordinary edits and rolls back its failed receipt', async () => {
  const f = await createConversationSwitchFixture()
  const journal = await open(f)
  try {
    const original = await journal.queuedMessages.insert({ messageId: 'draft', body })
    const before = f.host.db
      .prepare('SELECT * FROM queued_message_origins WHERE message_id=?')
      .get('draft')
    await journal.queuedMessages.update({
      messageId: 'draft',
      expectedBodyFingerprint: original.fingerprint,
      text: 'edited'
    })
    expect(
      f.host.db.prepare('SELECT * FROM queued_message_origins WHERE message_id=?').get('draft')
    ).toEqual(before)
    await expect(
      journal.queuedMessages.insert(
        { messageId: 'failed', body },
        {
          write: () => {
            throw new Error('receipt')
          },
          committed: () => {}
        }
      )
    ).rejects.toThrow('receipt')
    expect(
      f.host.db.prepare('SELECT 1 FROM queued_message_origins WHERE message_id=?').get('failed')
    ).toBeUndefined()
    expect(journal.queuedMessages.get('failed')).toBeNull()
  } finally {
    await journal.close()
    f.close()
  }
})

it('refuses unknown legacy origin after enrollment even if its current membership is missing', async () => {
  const f = await createConversationSwitchFixture(undefined, (db) => {
    // Released legacy queue fixture: absent origins remain unknown through adoption.
    db.prepare(`INSERT INTO queued_messages(session_id,message_id,position,body_json,fingerprint,created_at,host_instance,state)
      VALUES('session-a','unknown-enrolled',1,?,'legacy-fingerprint',11,'legacy-host','waiting')`).run(
      JSON.stringify(body)
    )
  })
  const journal = await open(f)
  try {
    const assertCurrent = () =>
      assertQueuedDraftCurrentGeneration(f.host.db, {
        sessionId: 'session-a',
        messageId: 'unknown-enrolled'
      })
    expect(assertCurrent).toThrow('stale-generation')
    f.host.db.prepare('DELETE FROM conversation_participants WHERE session_id=?').run('session-a')
    expect(assertCurrent).toThrow('stale-generation')
    expect(
      f.host.db
        .prepare(
          'SELECT origin_json FROM queued_message_origins WHERE session_id=? AND message_id=?'
        )
        .get('session-a', 'unknown-enrolled')?.origin_json ?? null
    ).toBeNull()
  } finally {
    await journal.close()
    f.close()
  }
})

it('does not mistake removed feature membership for a never-feature standalone draft', async () => {
  const f = await createConversationSwitchFixture(undefined, async (_db, host) => {
    const journal = new AgentSessionJournal({
      database: host,
      identity: {
        sessionId: 'session-a',
        workspaceId: 'folder',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('session-a')
      }
    })
    await journal.open()
    try {
      await journal.queuedMessages.insert({ messageId: 'pre-enrollment', body })
    } finally {
      await journal.close()
    }
  })
  const journal = await open(f)
  try {
    f.host.db.prepare('DELETE FROM conversation_participants WHERE session_id=?').run('session-a')
    const card = journal.queuedMessages.get('pre-enrollment')!
    expect(() =>
      assertQueuedDraftCurrentGeneration(f.host.db, {
        sessionId: 'session-a',
        messageId: card.messageId
      })
    ).not.toThrow()
    expect(() =>
      journal.queuedMessages.assertConsumable({
        messageId: card.messageId,
        expect: 'waiting',
        fingerprint: card.fingerprint,
        consumedAs: 'send'
      })
    ).toThrow('stale-generation')
    const query = f.host.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT 1 FROM conversation_segments WHERE json_extract(record_json,'$.sessionId')=?"
      )
      .all('session-a')
    expect(
      query.some(
        (row) =>
          String(row.detail).startsWith('SEARCH conversation_segments') &&
          String(row.detail).includes('conversation_segments_by_session')
      )
    ).toBe(true)
    expect(query.some((row) => String(row.detail).includes('SCAN conversation_segments'))).toBe(
      false
    )
  } finally {
    await journal.close()
    f.close()
  }
})
