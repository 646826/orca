import type { ConversationPreparationSourceRow } from './conversation-preparation-source-reader'
import { recordConversationSourceVersion } from './conversation-source-version'
import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import {
  freezeConversationPreparationSources,
  readConversationPreparationSourceRows,
  readConversationPreparationSources
} from './conversation-preparation-sources'
import { insertJournalRow } from '../agent-session-journal/journal-row-table'
import { attributeConversationSourceBoundary } from './conversation-source-attribution'
import { releaseJournalEpochPins } from '../agent-session-journal/journal-epoch-pins'
const fixtures: Awaited<ReturnType<typeof createConversationSwitchFixture>>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.close()
  }
})
async function fixture() {
  const f = await createConversationSwitchFixture()
  fixtures.push(f)
  return f
}
async function batch(mode: 'current' | 'mixed' | 'unknown') {
  const f = await fixture(),
    db = f.host.db
  const first = JSON.parse(
    String(
      db.prepare('SELECT record_json FROM conversation_segments WHERE ordinal=1').get()?.record_json
    )
  )
  const old = { ...first, segmentId: 'old', contextGeneration: 2, ordinal: 3 }
  db.prepare('INSERT INTO conversation_segments VALUES(?,?,?,?)').run(
    old.segmentId,
    old.conversationId,
    3,
    JSON.stringify(old)
  )
  const origin = (segment: typeof first) => ({
    conversationId: segment.conversationId,
    segmentId: segment.segmentId,
    contextGeneration: segment.contextGeneration,
    nativeBindingGeneration: segment.nativeBindingGeneration
  })
  f.host.transaction((db) => {
    insertJournalRow(db, 'session-a', {
      v: 1,
      kind: 'lifecycle-batch',
      settlementId: 'batch',
      epoch: 'epoch-session-a',
      seq: 2,
      fence: 1,
      ts: 2,
      mutations: [
        {
          kind: 'item',
          itemId: 'one',
          revision: 1,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: '保留🙂' }] }
        },
        { kind: 'tombstone', itemId: 'two', revision: 1 }
      ]
    })
    attributeConversationSourceBoundary(db, first.segmentId, 'session-a', 1, {
      sessionId: 'session-a',
      epoch: 'epoch-session-a',
      endSequence: 2
    })
    for (const [i, path] of ['$', '$.mutations[0]', '$.mutations[1]'].entries()) {
      const captured = origin(mode === 'mixed' && i === 2 ? old : first)
      db.prepare('INSERT INTO conversation_origin_rows VALUES(?,?,?,?,?,?,?,?,?)').run(
        'session-a',
        'epoch-session-a',
        2,
        path,
        '[{"kind":"event","id":"batch"}]',
        mode === 'unknown' && i === 2 ? null : JSON.stringify(captured),
        captured.conversationId,
        captured.contextGeneration,
        captured.nativeBindingGeneration
      )
    }
  })
  return f
}
it('reads durable metadata and streams every selected batch byte with independent integrity', async () => {
  const f = await batch('current'),
    signal = new AbortController().signal
  const frozen = await freezeConversationPreparationSources(
    f.host.db,
    f.records.conversations.intent(f.operationKey)!,
    signal
  )
  expect(readConversationPreparationSources(f.host.db, frozen.ownerId)).toEqual(frozen)
  const rows: ConversationPreparationSourceRow[] = []
  for await (const row of readConversationPreparationSourceRows(
    f.host.db,
    frozen.ownerId,
    signal
  )) {
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of row.readChunks()) {
      hash.update(chunk)
      bytes += chunk.byteLength
    }
    expect(hash.digest('hex')).toBe(row.version.sha256)
    expect(bytes).toBe(row.byteLength)
    rows.push(row)
  }
  expect(rows).toHaveLength(2)
  expect(rows[1]?.mutationCount).toBe(2)
  f.host.transaction((db) => releaseJournalEpochPins(db, frozen.ownerId))
  await expect(
    (async () => {
      for await (const _ of rows[1]!.readChunks()) {
        /* Exhaust verified bytes. */
      }
    })()
  ).rejects.toThrow('pin missing')
})
it.each(['mixed', 'unknown'] as const)(
  'blocks %s batch provenance before publishing snapshot',
  async (mode) => {
    const f = await batch(mode)
    await expect(
      freezeConversationPreparationSources(
        f.host.db,
        f.records.conversations.intent(f.operationKey)!,
        new AbortController().signal
      )
    ).rejects.toThrow(mode === 'mixed' ? 'mixed-generation' : 'unresolved')
    expect(
      f.host.db.prepare('SELECT COUNT(*) n FROM conversation_preparation_sources').get()?.n
    ).toBe(0)
  }
)
it('refuses a canonical row whose payload sequence disagrees with storage identity', async () => {
  const f = await fixture()
  const row = JSON.parse(
    String(
      f.host.db
        .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND seq=1')
        .get('session-a')?.row_json
    )
  )
  row.seq = 9
  f.host.db
    .prepare('INSERT INTO journal_rows VALUES(?,?,?,?,?)')
    .run('session-a', 'epoch-session-a', 2, 2, JSON.stringify(row))
  await expect(
    freezeConversationPreparationSources(
      f.host.db,
      f.records.conversations.intent(f.operationKey)!,
      new AbortController().signal
    )
  ).rejects.toThrow('integrity mismatch')
})
it('refuses a late source row on replay of a durable frozen snapshot', async () => {
  const f = await fixture(),
    signal = new AbortController().signal
  const frozen = await freezeConversationPreparationSources(
    f.host.db,
    f.records.conversations.intent(f.operationKey)!,
    signal
  )
  f.append('session-a', 2)
  await expect(
    (async () => {
      for await (const _ of readConversationPreparationSourceRows(
        f.host.db,
        frozen.ownerId,
        signal
      )) {
        /* Exhaust the selection. */
      }
    })()
  ).rejects.toThrow('provenance changed')
})

it('keeps source freshness valid across derivative export proof and candidate-only activity', async () => {
  const f = await fixture(),
    signal = new AbortController().signal
  const frozen = await freezeConversationPreparationSources(
    f.host.db,
    f.records.conversations.intent(f.operationKey)!,
    signal
  )
  const raw = String(
    f.host.db
      .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND seq=1')
      .get('session-a')?.row_json
  )
  f.host.transaction((db) => {
    recordConversationSourceVersion(db, {
      pin: { ownerId: frozen.ownerId, ...frozen.boundaries[0]! },
      source: { sessionId: 'session-a', epoch: 'epoch-session-a', sequence: 1 },
      sha256: createHash('sha256').update(raw).digest('hex'),
      byteLength: Buffer.byteLength(raw),
      kind: 'epoch',
      mutationCount: 0
    })
    db.prepare(
      "UPDATE conversation_segments SET record_json=record_json WHERE json_extract(record_json,'$.sessionId')=?"
    ).run('session-b')
  })
  expect(readConversationPreparationSources(f.host.db, frozen.ownerId)).toEqual(frozen)
})

it('hashes oversized Unicode rows through bounded SQLite byte reads', async () => {
  const f = await fixture(),
    signal = new AbortController().signal
  const segment = JSON.parse(
    String(
      f.host.db.prepare('SELECT record_json FROM conversation_segments WHERE ordinal=1').get()
        ?.record_json
    )
  )
  f.host.transaction((db) => {
    insertJournalRow(db, 'session-a', {
      v: 1,
      kind: 'item',
      epoch: 'epoch-session-a',
      seq: 2,
      ts: 2,
      fence: 1,
      itemId: 'large',
      revision: 1,
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '保留🙂'.repeat(200000) }]
      }
    })
    attributeConversationSourceBoundary(db, segment.segmentId, 'session-a', 1, {
      sessionId: 'session-a',
      epoch: 'epoch-session-a',
      endSequence: 2
    })
  })
  const prepare = f.host.db.prepare.bind(f.host.db)
  const spy = vi.spyOn(f.host.db, 'prepare').mockImplementation((sql) => {
    if (/SELECT\s+row_json/i.test(sql)) {
      throw new Error('full canonical row read forbidden')
    }
    return prepare(sql)
  })
  try {
    const frozen = await freezeConversationPreparationSources(
      f.host.db,
      f.records.conversations.intent(f.operationKey)!,
      signal
    )
    let large = false
    for await (const row of readConversationPreparationSourceRows(
      f.host.db,
      frozen.ownerId,
      signal
    )) {
      const hash = createHash('sha256')
      for await (const chunk of row.readChunks()) {
        expect(chunk.byteLength).toBeLessThanOrEqual(1024 * 1024)
        hash.update(chunk)
      }
      expect(hash.digest('hex')).toBe(row.version.sha256)
      large ||= row.byteLength > 1024 * 1024
    }
    expect(large).toBe(true)
  } finally {
    spy.mockRestore()
  }
})

it('refuses malformed UTF-8 bytes instead of validating a replacement-character projection', async () => {
  const f = await fixture()
  const original = JSON.parse(
    String(
      f.host.db
        .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND seq=1')
        .get('session-a')?.row_json
    )
  )
  original.seq = 2
  const raw = JSON.stringify(original),
    marker = raw.indexOf('session_created')
  expect(marker).toBeGreaterThan(0)
  const bytes = Buffer.concat([
    Buffer.from(raw.slice(0, marker)),
    Buffer.from([255]),
    Buffer.from(raw.slice(marker + 1))
  ])
  f.host.db
    .prepare('INSERT INTO journal_rows VALUES(?,?,?,?,CAST(? AS TEXT))')
    .run('session-a', 'epoch-session-a', 2, 2, bytes)
  await expect(
    freezeConversationPreparationSources(
      f.host.db,
      f.records.conversations.intent(f.operationKey)!,
      new AbortController().signal
    )
  ).rejects.toThrow(TypeError)
  expect(
    f.host.db.prepare('SELECT COUNT(*) n FROM conversation_preparation_sources').get()?.n
  ).toBe(0)
})

it('never includes an unselected large unsent draft between delivered facts in preparation', async () => {
  const { AgentSessionJournal } = await import('../agent-session-journal/journal-store')
  const { codexProviderHandle } =
    await import('../../../shared/agent-session-provider-handle-encoding')
  const secret = 'UNSENT_PRIVATE_DRAFT_'.repeat(5000)
  const f = await createConversationSwitchFixture('delivered user turn', async (_db, host) => {
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
      await journal.queuedMessages.insert({
        messageId: 'private',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: secret }] }
      })
      await journal.appendItem(
        { provider: 'codex', threadId: 'session-a', turnId: 'answer', ordinal: 1 },
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'delivered answer' }]
        },
        { fence: 1, turnScope: { kind: 'thread' } }
      )
    } finally {
      await journal.close()
    }
  })
  fixtures.push(f)
  const frozen = await freezeConversationPreparationSources(
    f.host.db,
    f.records.conversations.intent(f.operationKey)!,
    new AbortController().signal
  )
  const rows: ConversationPreparationSourceRow[] = []
  for await (const row of readConversationPreparationSourceRows(
    f.host.db,
    frozen.ownerId,
    new AbortController().signal
  )) {
    rows.push(row)
  }
  expect(rows.some((row) => row.kind === 'queue')).toBe(false)
  let text = ''
  for (const row of rows) {
    for await (const bytes of row.readChunks()) {
      text += Buffer.from(bytes).toString('utf8')
    }
  }
  expect(text).toContain('delivered user turn')
  expect(text).toContain('delivered answer')
  expect(text).not.toContain('UNSENT_PRIVATE_DRAFT_')
  expect(
    f.host.db
      .prepare("SELECT 1 FROM journal_rows WHERE json_extract(row_json,'$.kind')='queue'")
      .get()
  ).toBeDefined()
})

it('keeps prepared transcript authority stable across unsent queue-only writes', async () => {
  const f = await createConversationSwitchFixture('delivered turn')
  fixtures.push(f)
  const { AgentSessionJournal } = await import('../agent-session-journal/journal-store')
  const { codexProviderHandle } =
    await import('../../../shared/agent-session-provider-handle-encoding')
  const { createConversationOriginRowHook } = await import('./conversation-origin-rows')
  const journal = new AgentSessionJournal({
    database: f.host,
    identity: {
      sessionId: 'session-a',
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('session-a')
    },
    requiredInTransaction: createConversationOriginRowHook('session-a')
  })
  await journal.open()
  try {
    const frozen = await freezeConversationPreparationSources(
      f.host.db,
      f.records.conversations.intent(f.operationKey)!,
      new AbortController().signal
    )
    const card = await journal.queuedMessages.insert({
      messageId: 'later-draft',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'not delivered' }] }
    })
    await journal.queuedMessages.update({
      messageId: 'later-draft',
      expectedBodyFingerprint: card.fingerprint,
      text: 'still not delivered'
    })
    await journal.queuedMessages.withdraw(['later-draft'])
    const rows: ConversationPreparationSourceRow[] = []
    for await (const row of readConversationPreparationSourceRows(
      f.host.db,
      frozen.ownerId,
      new AbortController().signal
    )) {
      rows.push(row)
    }
    expect(rows.map((row) => row.kind)).not.toContain('queue')
    expect(rows.length).toBeGreaterThan(0)
  } finally {
    await journal.close()
  }
})

it('does not let an unknown legacy draft block unrelated delivered transcript preparation', async () => {
  const f = await createConversationSwitchFixture('known delivered turn')
  fixtures.push(f)
  const body = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text: 'unknown historical draft' }]
  }
  const { agentSessionSendBodyFingerprint } =
    await import('../../../shared/structured-agent-session-send-mutation')
  // Deliberate pre-journal queue fixture; open performs the real adoption.
  f.host.db
    .prepare(`INSERT INTO queued_messages(session_id,message_id,position,body_json,fingerprint,created_at,host_instance,state)
    VALUES('session-a','legacy',1,?,?,1,'legacy','waiting')`)
    .run(JSON.stringify(body), agentSessionSendBodyFingerprint('session-a', body))
  const { AgentSessionJournal } = await import('../agent-session-journal/journal-store')
  const { codexProviderHandle } =
    await import('../../../shared/agent-session-provider-handle-encoding')
  const { createConversationOriginRowHook } = await import('./conversation-origin-rows')
  const journal = new AgentSessionJournal({
    database: f.host,
    identity: {
      sessionId: 'session-a',
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('session-a')
    },
    requiredInTransaction: createConversationOriginRowHook('session-a')
  })
  await journal.open()
  try {
    expect(
      f.host.db
        .prepare("SELECT origin_json FROM queued_message_origins WHERE message_id='legacy'")
        .get()?.origin_json
    ).toBeNull()
    const frozen = await freezeConversationPreparationSources(
      f.host.db,
      f.records.conversations.intent(f.operationKey)!,
      new AbortController().signal
    )
    const rows: ConversationPreparationSourceRow[] = []
    for await (const row of readConversationPreparationSourceRows(
      f.host.db,
      frozen.ownerId,
      new AbortController().signal
    )) {
      rows.push(row)
    }
    expect(rows.some((row) => row.kind === 'queue')).toBe(false)
    const card = journal.queuedMessages.get('legacy')!
    expect(() =>
      journal.queuedMessages.assertConsumable({
        messageId: 'legacy',
        expect: 'waiting',
        fingerprint: card.fingerprint,
        consumedAs: 'send'
      })
    ).toThrow('stale-generation')
  } finally {
    await journal.close()
  }
})
