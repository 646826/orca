import { expect, test } from 'vitest'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import { readConversationAuthorityRevision } from './conversation-context-authority-revision'
import { readConversationSourceProvenance } from './conversation-source-provenance-revision'

test('batch proof changes invalidate authority and source freshness without counting candidate effects as source edits', async () => {
  const f = await createConversationSwitchFixture()
  try {
    const intent = f.records.conversations.intent(f.operationKey)!
    const sources = () =>
      readConversationSourceProvenance(f.host.db, intent.conversationId, intent.targetSessionId)
    const before = sources()
    const revision = readConversationAuthorityRevision(f.host.db)
    f.host.db
      .prepare('INSERT INTO conversation_origin_batch_envelopes VALUES(?,?,?,?)')
      .run('session-a', 'epoch-session-a', 1, 1)
    expect(sources()).not.toEqual(before)
    expect(readConversationAuthorityRevision(f.host.db)).toBeGreaterThan(revision)
    const frozen = sources()
    f.host.db
      .prepare('INSERT INTO conversation_origin_batch_envelopes VALUES(?,?,?,?)')
      .run('session-b', 'epoch-session-b', 1, 1)
    expect(sources()).toEqual(frozen)
    f.host.db
      .prepare('UPDATE conversation_origin_batch_envelopes SET mutation_count=2 WHERE session_id=?')
      .run('session-a')
    expect(sources()).not.toEqual(frozen)
    const updated = sources()
    f.host.db
      .prepare('DELETE FROM conversation_origin_batch_envelopes WHERE session_id=?')
      .run('session-a')
    expect(sources()).not.toEqual(updated)
  } finally {
    f.close()
  }
})
