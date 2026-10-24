import { resolveConversationOriginEnvelope } from './conversation-origin-envelope'
import {
  bindConversationAcquisition,
  readConversationCapturedScope,
  recordConversationOriginEnrollment,
  readConversationEnrollmentOrigin
} from './conversation-origin-capture'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  bindConversationOrigin,
  readConversationOrigin,
  aliasConversationOrigin
} from './conversation-origin'
import {
  assertConversationOriginsResolved,
  resolveConversationOrigins,
  readConversationRowOrigins
} from './conversation-origin-rows'
import { createOriginFixture, identity, old, fresh, item } from './conversation-origin.fixture'
let fixture: Awaited<ReturnType<typeof createOriginFixture>>
let host: typeof fixture.host
let journal: typeof fixture.journal
let captured = { conversationId: 'c', contextGeneration: 1, nativeBindingGeneration: 1 }
beforeEach(async () => {
  captured = { conversationId: 'c', contextGeneration: 1, nativeBindingGeneration: 1 }
  fixture = await createOriginFixture(() => captured)
  host = fixture.host
  journal = fixture.journal
})
afterEach(async () => {
  await fixture.close()
})
it('keeps original item attribution through a later activation and refuses rebinding', async () => {
  host.transaction((db) => bindConversationOrigin(db, { sessionId: 'a', key: item, origin: old }))
  await journal.appendItem(
    identity,
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'late A1' }] },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  expect(
    host.db
      .prepare('SELECT segment_id FROM conversation_source_attribution WHERE sequence=?')
      .get(journal.cursor().sequence)?.segment_id
  ).toBe('a1')
  expect(() =>
    host.transaction((db) =>
      bindConversationOrigin(db, { sessionId: 'a', key: item, origin: fresh })
    )
  ).toThrow()
  expect(readConversationOrigin(host.db, 'a', item, 1)).toEqual(old)
})
it('preserves unknown evidence and blocks strict switch until exact durable correlation arrives', async () => {
  await journal.appendItem(
    identity,
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'unresolved' }] },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  expect(() => assertConversationOriginsResolved(host.db, 'c', 1)).toThrow('unresolved')
  expect(journal.snapshot().items).toHaveLength(1)
  host.transaction((db) => {
    bindConversationOrigin(db, {
      sessionId: 'a',
      key: { kind: 'submission', id: 'send-old' },
      origin: old
    })
    aliasConversationOrigin(db, {
      sessionId: 'a',
      nativeBindingGeneration: 1,
      from: { kind: 'submission', id: 'send-old' },
      to: item
    })
    resolveConversationOrigins(db, 'a', 128)
  })
  expect(() => assertConversationOriginsResolved(host.db, 'c', 1)).not.toThrow()
})
it('records distinct lifecycle mutation origins without copying one producer across the batch', async () => {
  const second = { ...identity, ordinal: 2 }
  host.transaction((db) => {
    bindConversationOrigin(db, { sessionId: 'a', key: item, origin: old })
    bindConversationOrigin(db, {
      sessionId: 'a',
      key: { kind: 'item', id: agentJournalItemKey(second) },
      origin: fresh
    })
    bindConversationOrigin(db, {
      sessionId: 'a',
      key: { kind: 'event', id: 'settlement:mixed' },
      origin: fresh
    })
  })
  await journal.appendLifecycleBatch({
    settlementId: 'mixed',
    fence: 1,
    mutations: [identity, second].map((identity) => ({
      kind: 'item' as const,
      identity,
      body: {
        kind: 'message' as const,
        role: 'assistant' as const,
        blocks: [{ type: 'text' as const, text: 'settled' }]
      },
      turnScope: { kind: 'thread' as const }
    }))
  })
  const rows = host.db
    .prepare('SELECT atom_path,origin_json FROM conversation_origin_rows ORDER BY atom_path')
    .all()
  expect(rows.map((row) => [row.atom_path, JSON.parse(String(row.origin_json)).segmentId])).toEqual(
    [
      ['$', 'a3'],
      ['$.mutations[0]', 'a1'],
      ['$.mutations[1]', 'a3']
    ]
  )
})
it('rolls back actual journal and metadata together when required attribution fails', async () => {
  host.transaction((db) => bindConversationOrigin(db, { sessionId: 'a', key: item, origin: old }))
  host.db.exec(
    "CREATE TRIGGER reject_origin BEFORE INSERT ON conversation_origin_rows BEGIN SELECT RAISE(ABORT,'origin unavailable'); END"
  )
  const before = journal.cursor()
  await expect(
    journal.appendItem(
      identity,
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'must rollback' }] },
      { fence: 1, turnScope: { kind: 'thread' } }
    )
  ).rejects.toThrow('origin unavailable')
  expect(journal.cursor()).toEqual(before)
  expect(host.db.prepare('SELECT COUNT(*) n FROM conversation_source_attribution').get()?.n).toBe(0)
})

it('retains unresolved evidence and returns no partial atom authorization', async () => {
  await journal.appendItem(
    identity,
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'unknown source' }] },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  expect(
    host.db
      .prepare('SELECT 1 FROM journal_epoch_pins WHERE owner_id=? AND session_id=? AND epoch=?')
      .get('conversation-origin:a', 'a', journal.cursor().epoch)
  ).toBeDefined()
  expect(() =>
    readConversationRowOrigins(host.db, {
      sessionId: 'a',
      epoch: journal.cursor().epoch,
      sequence: journal.cursor().sequence
    })
  ).toThrow('unresolved')
})
it('uses exact turn correlation once then keeps the immutable item origin', async () => {
  host.transaction((db) =>
    bindConversationOrigin(db, {
      sessionId: 'a',
      key: { kind: 'turn', id: 'turn-old' },
      origin: old
    })
  )
  await journal.appendItem(
    identity,
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'first' }] },
    { fence: 1, turnScope: { kind: 'turn', turnItemId: 'turn-old' } }
  )
  host.transaction((db) =>
    bindConversationOrigin(db, {
      sessionId: 'a',
      key: { kind: 'turn', id: 'turn-new' },
      origin: fresh
    })
  )
  await journal.appendItem(
    identity,
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'late revised' }] },
    { fence: 2, turnScope: { kind: 'turn', turnItemId: 'turn-new' } }
  )
  expect(
    readConversationRowOrigins(host.db, {
      sessionId: 'a',
      epoch: journal.cursor().epoch,
      sequence: journal.cursor().sequence
    })
  ).toEqual([{ atomPath: '$', origin: old }])
})
it('refuses wrong native generation and metadata resolution outside a transaction', () => {
  expect(() =>
    host.transaction((db) =>
      bindConversationOrigin(db, {
        sessionId: 'a',
        key: item,
        origin: { ...old, nativeBindingGeneration: 2 }
      })
    )
  ).toThrow('identity mismatch')
  expect(() => resolveConversationOrigins(host.db, 'a')).toThrow('transaction')
})
it('does not reuse reminted provider IDs across captured native bindings', async () => {
  host.transaction((db) => bindConversationOrigin(db, { sessionId: 'a', key: item, origin: old }))
  captured = { ...captured, nativeBindingGeneration: 2 }
  await journal.appendItem(
    identity,
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'new native identity' }] },
    { fence: 2, turnScope: { kind: 'thread' } }
  )
  expect(() => assertConversationOriginsResolved(host.db, 'c', 1)).toThrow('unresolved')
  expect(host.db.prepare('SELECT COUNT(*) n FROM conversation_source_attribution').get()?.n).toBe(0)
})
it('does not let archived unresolved evidence block a cleared generation', async () => {
  await journal.appendItem(
    identity,
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'old unknown' }] },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  expect(() => assertConversationOriginsResolved(host.db, 'c', 1)).toThrow('unresolved')
  expect(() => assertConversationOriginsResolved(host.db, 'c', 2)).not.toThrow()
})
it('captures acquisition scope immutably and refuses generation rebinding', () => {
  host.transaction((db) =>
    bindConversationAcquisition(db, { sessionId: 'a', fence: 7, origin: old })
  )
  const row = {
    v: 1,
    kind: 'item' as const,
    epoch: journal.cursor().epoch,
    seq: 2,
    fence: 7,
    ts: 1,
    itemId: item.id,
    revision: 1,
    body: { kind: 'message' as const, role: 'assistant' as const, blocks: [] },
    ownerFence: 7
  }
  expect(readConversationCapturedScope(host.db, 'a', row, '$')).toEqual(old)
  expect(readConversationCapturedScope(host.db, 'a', { ...row, fence: 8 }, '$')).toBeNull()
  expect(readConversationCapturedScope(host.db, 'a', { ...row, ownerFence: 99 }, '$')).toBeNull()
  host.db
    .prepare(
      "UPDATE conversation_segments SET record_json=json_set(record_json,'$.nativeBindingGeneration',2) WHERE segment_id='a3'"
    )
    .run()
  expect(() =>
    host.transaction((db) =>
      bindConversationAcquisition(db, {
        sessionId: 'a',
        fence: 7,
        origin: { ...fresh, nativeBindingGeneration: 2 }
      })
    )
  ).toThrow('cannot be rebound')
})
it('freezes O(1) enrollment and never authorizes rows beyond the initial boundary', () => {
  const source = { sessionId: 'a', epoch: journal.cursor().epoch, sequence: 1 }
  host.transaction((db) =>
    recordConversationOriginEnrollment(db, {
      sessionId: 'a',
      epoch: source.epoch,
      endSequence: 1,
      origin: old
    })
  )
  expect(readConversationEnrollmentOrigin(host.db, source)).toEqual(old)
  expect(readConversationEnrollmentOrigin(host.db, { ...source, sequence: 2 })).toBeNull()
  expect(() =>
    host.transaction((db) =>
      recordConversationOriginEnrollment(db, {
        sessionId: 'a',
        epoch: source.epoch,
        endSequence: 2,
        origin: old
      })
    )
  ).toThrow('boundary')
  expect(host.db.prepare('SELECT COUNT(*) n FROM conversation_origin_rows').get()?.n).toBe(0)
})

it.each(['same', 'mixed', 'unknown', 'missing'] as const)(
  'derives only unanimous structural batch envelopes: %s',
  async (scenario) => {
    const second = { ...identity, ordinal: 2 }
    host.transaction((db) => {
      bindConversationOrigin(db, { sessionId: 'a', key: item, origin: old })
      if (scenario !== 'unknown' && scenario !== 'missing') {
        bindConversationOrigin(db, {
          sessionId: 'a',
          key: { kind: 'item', id: agentJournalItemKey(second) },
          origin: scenario === 'same' ? old : fresh
        })
      }
    })
    await journal.appendLifecycleBatch({
      settlementId: 'structural',
      fence: 1,
      mutations: [identity, second].map((identity) => ({
        kind: 'item' as const,
        identity,
        body: {
          kind: 'message' as const,
          role: 'assistant' as const,
          blocks: [{ type: 'text' as const, text: 'settled' }]
        },
        turnScope: { kind: 'thread' as const }
      }))
    })
    if (scenario === 'missing') {
      host.transaction((db) => {
        db.prepare("DELETE FROM conversation_origin_rows WHERE atom_path='$.mutations[1]'").run()
        const row = db
          .prepare("SELECT epoch,sequence FROM conversation_origin_rows WHERE atom_path='$'")
          .get()!
        expect(
          resolveConversationOriginEnvelope(db, 'a', String(row.epoch), Number(row.sequence))
        ).toBe(false)
      })
    }
    const envelope = host.db
      .prepare("SELECT origin_json FROM conversation_origin_rows WHERE atom_path='$'")
      .get()
    if (scenario === 'same') {
      expect(JSON.parse(String(envelope?.origin_json)).segmentId).toBe(old.segmentId)
    } else {
      expect(envelope?.origin_json).toBeNull()
    }
  }
)
