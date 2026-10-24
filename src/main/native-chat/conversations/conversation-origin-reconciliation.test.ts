import { expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { bindConversationOrigin } from './conversation-origin'
import { assertConversationOriginsResolved } from './conversation-origin-rows'
import { reconcileConversationOrigins } from './conversation-origin-reconciliation'
import { createOriginFixture, identity, old } from './conversation-origin.fixture'

it('settles more than one batch of causally proven late items without holding a transaction across waits', async () => {
  const { host, journal, close } = await createOriginFixture()
  try {
    for (let ordinal = 1; ordinal <= 257; ordinal++) {
      const item = { ...identity, ordinal }
      await journal.appendItem(
        item,
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'late' }] },
        { fence: 1, turnScope: { kind: 'thread' } }
      )
    }
    host.transaction((db) => {
      for (let ordinal = 1; ordinal <= 257; ordinal++) {
        bindConversationOrigin(db, {
          sessionId: 'a',
          origin: old,
          key: { kind: 'item', id: agentJournalItemKey({ ...identity, ordinal }) }
        })
      }
    })
    const reconcile = reconcileConversationOrigins(host.db, 'a', new AbortController().signal)
    expect(host.db.isTransaction).toBe(false)
    await reconcile
    expect(() => assertConversationOriginsResolved(host.db, 'c', 1)).not.toThrow()
    expect(
      host.db
        .prepare('SELECT count(*) n FROM conversation_origin_rows WHERE origin_json IS NOT NULL')
        .get()?.n
    ).toBe(257)
  } finally {
    await close()
  }
})
