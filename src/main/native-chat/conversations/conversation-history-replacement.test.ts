import { readdirSync } from 'node:fs'
import { ConversationScratchClient } from './conversation-scratch-client'
import { installScratchWorkerFixture } from './conversation-scratch-worker-setup.test-fixture'
import { afterEach, expect, test, vi } from 'vitest'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import { readSegments } from './conversation-read-model'
import { replaceJournalEpoch } from '../agent-session-journal/journal-epoch-replacement'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { attributeConversationSourceBoundary } from './conversation-source-attribution'
import { conversationHistoryRevision, readConversationHistoricalPage } from './conversation-history'
import {
  insertJournalRow,
  publishJournalSessionEpoch
} from '../agent-session-journal/journal-row-table'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
const fixtures: Awaited<ReturnType<typeof createConversationSwitchFixture>>[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) {
    f.close()
  }
})
test('an uncaptured current epoch cannot present older captured history as complete', async () => {
  const f = await createConversationSwitchFixture()
  fixtures.push(f)
  const intent = f.records.conversations.intent(f.operationKey)!
  const segment = readSegments(f.host.db, intent.conversationId).find(
    (s) => s.sessionId === 'session-a'
  )!
  f.host.transaction((db) => {
    publishJournalSessionEpoch(db, { sessionId: 'session-a', workspaceId: 'folder' }, 'uncaptured')
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
  expect(page.status).toBe('source-unavailable')
  expect(page.items).toEqual([])
})
test('two real replacements coalesce stable IDs, preserve identical text identities and remove omitted history', async () => {
  const f = await createConversationSwitchFixture()
  fixtures.push(f)
  const intent = f.records.conversations.intent(f.operationKey)!
  const segment = readSegments(f.host.db, intent.conversationId).find(
    (s) => s.sessionId === 'session-a'
  )!
  const identity = (ordinal: number) => ({
    provider: 'codex' as const,
    threadId: 'session-a',
    turnId: 'turn-1',
    ordinal
  })
  const replace = (epoch: string, items: readonly (readonly [number, string])[]) =>
    replaceJournalEpoch({
      database: f.host,
      identity: {
        sessionId: 'session-a',
        workspaceId: 'folder',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('session-a')
      },
      reason: 'legacy_import',
      fence: 1,
      items: items.map(([ordinal, text]) => ({
        identity: identity(ordinal),
        body: {
          kind: 'message' as const,
          role: 'assistant' as const,
          blocks: [{ type: 'text' as const, text }]
        },
        ownerFence: 1
      })),
      queuePause: { lifted: false, liveStop: null, reopened: false },
      queue: { cards: [], receipt: { write: () => {}, committed: () => {} } },
      now: () => 1,
      mintEpoch: () => epoch,
      onPublished: () => {},
      receipt: (cursor) => ({
        write(db) {
          for (let seq = 1; seq <= cursor.sequence; seq++) {
            attributeConversationSourceBoundary(db, segment.segmentId, 'session-a', 1, {
              sessionId: 'session-a',
              epoch: cursor.epoch,
              endSequence: seq
            })
          }
        },
        committed() {}
      })
    })
  replace('replacement-1', [
    [1, 'identical'],
    [2, 'identical'],
    [3, 'removed']
  ])
  replace('replacement-2', [
    [1, 'updated'],
    [2, 'identical']
  ])
  replace('replacement-3', [
    [1, 'final'],
    [2, 'identical']
  ])
  const input = {
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
    limit: 1,
    signal: new AbortController().signal
  }
  const first = await readConversationHistoricalPage(input)
  expect(first.status).toBe('more')
  expect(first.items).toHaveLength(1)
  expect(JSON.stringify(first.items[0]?.item)).toContain('final')
  expect(first.items[0]?.originSource.epoch).toBe('replacement-1')
  const second = await readConversationHistoricalPage({ ...input, after: first.next })
  expect(second.items).toHaveLength(1)
  expect(second.items[0]?.item.itemId).not.toBe(first.items[0]?.item.itemId)
  expect(JSON.stringify(second.items)).toContain('identical')
  expect(JSON.stringify(second.items)).not.toContain('removed')
  f.host.transaction((db) => {
    insertJournalRow(db, 'session-a', {
      kind: 'item',
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      epoch: 'replacement-3',
      seq: 4,
      ts: 4,
      fence: 1,
      itemId: agentJournalItemKey(identity(1)),
      revision: 2,
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'late original revision' }]
      }
    })
    attributeConversationSourceBoundary(db, segment.segmentId, 'session-a', 1, {
      sessionId: 'session-a',
      epoch: 'replacement-3',
      endSequence: 4
    })
  })
  const late = await readConversationHistoricalPage({
    ...input,
    limit: 128,
    expectedSourceRevision: conversationHistoryRevision(
      f.host.db,
      intent.conversationId,
      segment.segmentId
    )
  })
  expect(late.items).toHaveLength(2)
  expect(JSON.stringify(late.items[0]?.item)).toContain('late original revision')
  expect(late.items[0]?.originSource.epoch).toBe('replacement-1')
  expect(
    f.host.db.prepare('SELECT COUNT(*) n FROM journal_rows WHERE epoch=?').get('replacement-1')?.n
  ).toBe(4)
  f.host.db.prepare('DELETE FROM journal_epoch_pins WHERE session_id=?').run('session-a')
  f.host.db
    .prepare('DELETE FROM journal_rows WHERE session_id=? AND epoch=? AND seq=1')
    .run('session-a', 'epoch-session-a')
  const missing = await readConversationHistoricalPage({
    ...input,
    limit: 128,
    expectedSourceRevision: conversationHistoryRevision(
      f.host.db,
      intent.conversationId,
      segment.segmentId
    )
  })
  expect(missing.status).toBe('source-unavailable')
  expect(missing.items).toHaveLength(0)
})

installScratchWorkerFixture()

test('refuses a completed worker page when its source epoch was replaced before publication', async () => {
  const f = await createConversationSwitchFixture('captured before replacement')
  fixtures.push(f)
  const intent = f.records.conversations.intent(f.operationKey)!
  const segment = readSegments(f.host.db, intent.conversationId).find(
    (s) => s.sessionId === 'session-a'
  )!
  const input = {
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
  }
  const historyPage = ConversationScratchClient.prototype.historyPage
  let acknowledgedItems = 0
  vi.spyOn(ConversationScratchClient.prototype, 'historyPage').mockImplementationOnce(
    async function (this: ConversationScratchClient, ...args: Parameters<typeof historyPage>) {
      const page = await historyPage.apply(this, args)
      acknowledgedItems = page.items.length
      replaceJournalEpoch({
        database: f.host,
        identity: {
          sessionId: 'session-a',
          workspaceId: 'folder',
          hostId: 'local',
          agent: 'codex',
          providerHandle: codexProviderHandle('session-a')
        },
        reason: 'legacy_import',
        fence: 1,
        items: [
          {
            identity: {
              provider: 'codex',
              threadId: 'session-a',
              turnId: 'replacement',
              ordinal: 1
            },
            body: {
              kind: 'message',
              role: 'assistant',
              blocks: [{ type: 'text', text: 'replacement' }]
            },
            ownerFence: 1
          }
        ],
        queuePause: { lifted: false, liveStop: null, reopened: false },
        queue: { cards: [], receipt: { write() {}, committed() {} } },
        now: () => 2,
        mintEpoch: () => 'replacement-during-worker-page',
        onPublished() {},
        receipt: (cursor) => ({
          write(db) {
            for (let endSequence = 1; endSequence <= cursor.sequence; endSequence++) {
              attributeConversationSourceBoundary(db, segment.segmentId, 'session-a', 1, {
                sessionId: 'session-a',
                epoch: cursor.epoch,
                endSequence
              })
            }
          },
          committed() {}
        })
      })
      return page
    }
  )
  await expect(readConversationHistoricalPage(input)).rejects.toMatchObject({
    reason: 'stale-source'
  })
  expect(acknowledgedItems).toBe(1)
  expect(conversationHistoryRevision(f.host.db, intent.conversationId, segment.segmentId)).not.toBe(
    input.expectedSourceRevision
  )
  expect(
    f.host.db
      .prepare(
        "SELECT COUNT(*) count FROM journal_epoch_pins WHERE owner_id LIKE 'conversation-presentation:%'"
      )
      .get()?.count
  ).toBe(0)
  expect(
    readdirSync(f.host.stateDirectory).filter((name) => name.startsWith('conversation-scratch-'))
  ).toEqual([])
})
