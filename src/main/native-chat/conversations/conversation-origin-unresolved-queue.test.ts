import { expect, it } from 'vitest'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  assertConversationOriginsResolved,
  createConversationOriginRowHook
} from './conversation-origin-rows'
import { createConversationSwitchFixture } from './conversation-switch.fixture'

it.each([
  ['empty keys', '[]'],
  ['null keys', 'null'],
  ['non-array keys', '{}'],
  ['null first key', '[null]'],
  ['missing kind', '[{"id":"queue:draft"}]'],
  ['missing id', '[{"kind":"event"}]'],
  ['null kind', '[{"kind":null,"id":"queue:draft"}]'],
  ['null id', '[{"kind":"event","id":null}]'],
  ['both null', '[{"kind":null,"id":null}]'],
  ['non-event queue prefix', '[{"kind":"item","id":"queue:draft"}]'],
  ['ordinary event', '[{"kind":"event","id":"event:epoch:1"}]'],
  ['submission', '[{"kind":"submission","id":"send"}]']
])('blocks unresolved origin with %s instead of treating it as a queue fact', async (_, keys) => {
  const fixture = await createConversationSwitchFixture()
  try {
    const intent = fixture.records.conversations.intent(fixture.operationKey)!
    fixture.host.db
      .prepare('INSERT INTO conversation_origin_rows VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        'session-a',
        'unresolved-epoch',
        1,
        '$',
        keys,
        null,
        intent.conversationId,
        intent.contextGeneration,
        1
      )
    expect(() =>
      assertConversationOriginsResolved(
        fixture.host.db,
        intent.conversationId,
        intent.contextGeneration
      )
    ).toThrow('unresolved')
  } finally {
    fixture.close()
  }
})

it('excludes an actual journal queue fact without manufacturing its missing origin', async () => {
  const fixture = await createConversationSwitchFixture()
  const journal = new AgentSessionJournal({
    database: fixture.host,
    identity: {
      sessionId: 'session-a',
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('session-a')
    },
    requiredInTransaction: createConversationOriginRowHook('session-a')
  })
  try {
    await journal.open()
    await journal.queuedMessages.insert({
      messageId: 'draft',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'not sent' }] }
    })
    const cursor = journal.cursor()
    const row = fixture.host.db
      .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?')
      .get('session-a', cursor.epoch, cursor.sequence)
    expect(JSON.parse(String(row?.row_json))).toMatchObject({ kind: 'queue', messageId: 'draft' })
    fixture.host.db
      .prepare(
        'UPDATE conversation_origin_rows SET origin_json=NULL WHERE session_id=? AND epoch=? AND sequence=?'
      )
      .run('session-a', cursor.epoch, cursor.sequence)
    const intent = fixture.records.conversations.intent(fixture.operationKey)!
    expect(() =>
      assertConversationOriginsResolved(
        fixture.host.db,
        intent.conversationId,
        intent.contextGeneration
      )
    ).not.toThrow()
    expect(
      fixture.host.db
        .prepare(
          'SELECT keys_json,origin_json FROM conversation_origin_rows WHERE session_id=? AND epoch=? AND sequence=?'
        )
        .get('session-a', cursor.epoch, cursor.sequence)
    ).toEqual({ keys_json: '[{"kind":"event","id":"queue:draft"}]', origin_json: null })
  } finally {
    await journal.close()
    fixture.close()
  }
})
