import { forwardCompatibleBodies } from './conversation-forward-compatible-items.test-fixture'
import { installScratchWorkerFixture } from './conversation-scratch-worker-setup.test-fixture'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import { pinJournalEpoch } from '../agent-session-journal/journal-epoch-pins'
import { prepareConversationSourceAtomReceipt } from './conversation-source-atoms'
import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import { readSegments } from './conversation-read-model'
import { insertJournalRow } from '../agent-session-journal/journal-row-table'
import { attributeConversationSourceBoundary } from './conversation-source-attribution'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { readConversationHistoricalPage, conversationHistoryRevision } from './conversation-history'
const fixtures: Awaited<ReturnType<typeof createConversationSwitchFixture>>[] = []
const roots: string[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.close()
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
test('historical page uses retained reducer revisions, excludes candidate and rejects stale source revision', async () => {
  const f = await createConversationSwitchFixture()
  fixtures.push(f)
  const root = mkdtempSync(join(tmpdir(), 'orca-history-'))
  roots.push(root)
  const intent = f.records.conversations.intent(f.operationKey)!
  const segment = readSegments(f.host.db, intent.conversationId).find(
    (s) => s.sessionId === 'session-a'
  )!
  for (const [seq, revision, text] of [
    [2, 1, 'original'],
    [3, 2, 'revised constraint']
  ] as const) {
    f.host.transaction((db) => {
      insertJournalRow(db, 'session-a', {
        kind: 'item',
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch: 'epoch-session-a',
        seq,
        ts: seq,
        fence: 1,
        itemId: 'codex:message:history',
        revision,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
      })
      attributeConversationSourceBoundary(db, segment.segmentId, 'session-a', 1, {
        sessionId: 'session-a',
        epoch: 'epoch-session-a',
        endSequence: seq
      })
    })
  }
  const revision = conversationHistoryRevision(f.host.db, intent.conversationId, segment.segmentId)
  const input = {
    db: f.host.db,
    scratchDirectory: root,
    conversationId: intent.conversationId,
    segmentId: segment.segmentId,
    expectedSourceRevision: revision,
    after: null,
    limit: 128,
    signal: new AbortController().signal
  }
  const page = await readConversationHistoricalPage(input)
  expect(page.items).toHaveLength(1)
  expect(page.items[0]?.item.revision).toBe(2)
  expect(JSON.stringify(page.items)).toContain('revised constraint')
  expect(page.items[0]?.segmentId).toBe(segment.segmentId)
  await expect(
    readConversationHistoricalPage({ ...input, expectedSourceRevision: 'stale' })
  ).rejects.toMatchObject({ reason: 'stale-source' })
  await expect(
    readConversationHistoricalPage({ ...input, segmentId: intent.candidateSegmentId! })
  ).rejects.toThrow()
})

test.each([1, 2])(
  'mixed-origin lifecycle batch excludes proven sibling generation %s but refuses unknown authority',
  async (siblingGeneration) => {
    const f = await createConversationSwitchFixture()
    fixtures.push(f)
    const root = mkdtempSync(join(tmpdir(), 'orca-history-batch-'))
    roots.push(root)
    const intent = f.records.conversations.intent(f.operationKey)!
    const segment = readSegments(f.host.db, intent.conversationId).find(
      (s) => s.sessionId === 'session-a'
    )!
    const other = {
      ...segment,
      segmentId: 'later-segment',
      ordinal: 3,
      activationFence: 3,
      contextGeneration: siblingGeneration
    }
    f.host.db
      .prepare('INSERT INTO conversation_segments VALUES(?,?,?,?)')
      .run(other.segmentId, other.conversationId, other.ordinal, JSON.stringify(other))
    const source = { sessionId: 'session-a', epoch: 'epoch-session-a', sequence: 2 }
    const row: JournalRow = {
      kind: 'lifecycle-batch',
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      epoch: source.epoch,
      seq: 2,
      ts: 2,
      fence: 1,
      settlementId: 'mixed',
      mutations: [
        {
          kind: 'item',
          itemId: 'codex:message:mine',
          revision: 1,
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'visible own item' }]
          }
        },
        {
          kind: 'item',
          itemId: 'codex:message:other',
          revision: 1,
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'foreign sibling excluded' }]
          }
        }
      ]
    }
    const pin = {
      ownerId: 'history-batch',
      sessionId: source.sessionId,
      epoch: source.epoch,
      endSequence: 2
    }
    f.host.transaction((db) => {
      insertJournalRow(db, source.sessionId, row)
      attributeConversationSourceBoundary(db, segment.segmentId, source.sessionId, 1, {
        ...source,
        endSequence: 2
      })
      pinJournalEpoch(db, pin)
    })
    const origin = (segmentId: string) => ({
      sessionId: source.sessionId,
      conversationId: intent.conversationId,
      segmentId,
      contextGeneration: segmentId === other.segmentId ? siblingGeneration : 1,
      nativeBindingGeneration: 1
    })
    const receipt = prepareConversationSourceAtomReceipt(f.host.db, {
      pin,
      source,
      envelopeOrigin: origin(segment.segmentId),
      mutationOrigins: [
        { batchIndex: 0, origin: origin(segment.segmentId) },
        { batchIndex: 1, origin: origin(other.segmentId) }
      ]
    })
    f.host.transaction((db) => receipt.write(db, row))
    const page = await readConversationHistoricalPage({
      db: f.host.db,
      scratchDirectory: root,
      conversationId: intent.conversationId,
      segmentId: segment.segmentId,
      expectedSourceRevision: conversationHistoryRevision(
        f.host.db,
        intent.conversationId,
        segment.segmentId
      ),
      after: null,
      limit: 128,
      signal: new AbortController().signal
    })
    expect(page.items).toHaveLength(1)
    expect(JSON.stringify(page.items)).toContain('visible own item')
    expect(JSON.stringify(page.items)).not.toContain('foreign sibling')
    f.host.db
      .prepare('UPDATE conversation_source_atoms SET row_sha256=? WHERE segment_id=?')
      .run('0'.repeat(64), segment.segmentId)
    const refused = await readConversationHistoricalPage({
      db: f.host.db,
      scratchDirectory: root,
      conversationId: intent.conversationId,
      segmentId: segment.segmentId,
      expectedSourceRevision: conversationHistoryRevision(
        f.host.db,
        intent.conversationId,
        segment.segmentId
      ),
      after: null,
      limit: 128,
      signal: new AbortController().signal
    })
    expect(refused.status).toBe('source-unavailable')
    expect(refused.items).toHaveLength(0)
  }
)

test('unrelated participant output does not invalidate a frozen historical source', async () => {
  const f = await createConversationSwitchFixture()
  fixtures.push(f)
  const intent = f.records.conversations.intent(f.operationKey)!
  const segment = readSegments(f.host.db, intent.conversationId).find(
    (s) => s.sessionId === 'session-a'
  )!
  const before = conversationHistoryRevision(f.host.db, intent.conversationId, segment.segmentId)
  const append = (sessionId: string, seq: number) =>
    f.host.transaction((db) =>
      insertJournalRow(db, sessionId, {
        kind: 'item',
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch: `epoch-${sessionId}`,
        seq,
        ts: seq,
        fence: 1,
        itemId: `codex:message:${sessionId}-${seq}`,
        revision: 1,
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'native output' }]
        }
      })
    )
  append('session-b', 2)
  expect(conversationHistoryRevision(f.host.db, intent.conversationId, segment.segmentId)).toBe(
    before
  )
  append('session-a', 2)
  expect(conversationHistoryRevision(f.host.db, intent.conversationId, segment.segmentId)).not.toBe(
    before
  )
})

installScratchWorkerFixture()

test('preserves forward-compatible body and block payloads through replay and history workers', async () => {
  const f = await createConversationSwitchFixture()
  fixtures.push(f)
  const intent = f.records.conversations.intent(f.operationKey)!
  const segment = readSegments(f.host.db, intent.conversationId).find(
    (s) => s.sessionId === 'session-a'
  )!
  f.host.transaction((db) => {
    for (const [index, body] of forwardCompatibleBodies.entries()) {
      const seq = index + 2
      db.prepare(
        'INSERT INTO journal_rows(session_id,epoch,seq,ts,row_json) VALUES(?,?,?,?,?)'
      ).run(
        'session-a',
        'epoch-session-a',
        seq,
        seq,
        JSON.stringify({
          v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
          epoch: 'epoch-session-a',
          seq,
          ts: seq,
          fence: 1,
          kind: 'item',
          itemId: `future-${seq}`,
          revision: 1,
          body
        })
      )
      attributeConversationSourceBoundary(db, segment.segmentId, 'session-a', 1, {
        sessionId: 'session-a',
        epoch: 'epoch-session-a',
        endSequence: seq
      })
    }
  })
  const page = await readConversationHistoricalPage({
    db: f.host.db,
    scratchDirectory: f.host.stateDirectory,
    conversationId: intent.conversationId,
    segmentId: segment.segmentId,
    expectedSourceRevision: conversationHistoryRevision(
      f.host.db,
      intent.conversationId,
      segment.segmentId
    ),
    after: null,
    limit: 128,
    signal: new AbortController().signal
  })
  expect(page.status).toBe('complete')
  expect(page.items.map(({ item }) => item.body)).toEqual(forwardCompatibleBodies)
})
