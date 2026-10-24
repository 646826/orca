import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClearStoreFixture, now, operation } from './conversation-clear-store.fixture'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createConversationOriginRowHook } from './conversation-origin-rows'
import { appendConversationClearJournals } from './conversation-clear-journals'
import { closeTestJournalHostDatabases } from '../agent-session-journal/journal-host-database-test-support'
import { installScratchWorkerFixture } from './conversation-scratch-worker-setup.test-fixture'
import { afterEach, expect, test, vi } from 'vitest'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import { readSegments } from './conversation-read-model'
import { attributeConversationSourceBoundary } from './conversation-source-attribution'
import { insertJournalRow } from '../agent-session-journal/journal-row-table'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { conversationHistoryRevision, readConversationHistoricalPage } from './conversation-history'
import { ConversationScratchClient } from './conversation-scratch-client'
const fixtures: Awaited<ReturnType<typeof createConversationSwitchFixture>>[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) {
    f.close()
  }
})
test('history index population yields to cancellation after a bounded batch', async () => {
  const f = await createConversationSwitchFixture()
  fixtures.push(f)
  const intent = f.records.conversations.intent(f.operationKey)!
  const segment = readSegments(f.host.db, intent.conversationId).find(
    (s) => s.sessionId === 'session-a'
  )!
  f.host.transaction((db) => {
    for (let seq = 2; seq <= 258; seq++) {
      insertJournalRow(db, 'session-a', {
        kind: 'item',
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch: 'epoch-session-a',
        seq,
        ts: seq,
        fence: 1,
        itemId: `codex:message:${seq}`,
        revision: 1,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'message' }] }
      })
      attributeConversationSourceBoundary(db, segment.segmentId, 'session-a', 1, {
        sessionId: 'session-a',
        epoch: 'epoch-session-a',
        endSequence: seq
      })
    }
  })
  const controller = new AbortController()
  let appended = 0
  const append = ConversationScratchClient.prototype.appendHistory
  vi.spyOn(ConversationScratchClient.prototype, 'appendHistory').mockImplementation(async function (
    this: ConversationScratchClient,
    ...args: Parameters<typeof append>
  ) {
    await append.apply(this, args)
    appended += args[0].length
    controller.abort()
  })
  await expect(
    readConversationHistoricalPage({
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
      signal: controller.signal
    })
  ).rejects.toThrow()
  expect(appended).toBeGreaterThan(0)
  expect(appended).toBeLessThanOrEqual(128)
})

installScratchWorkerFixture()

test('refuses an acknowledged history page when a real clear changes its captured segment before publication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-history-clear-await-'))
  const journals: AgentSessionJournal[] = []
  try {
    const { host, records, conversation } = await createClearStoreFixture(root)
    const segment = readSegments(host.db, conversation.conversationId).find(
      (s) => s.segmentId === conversation.activeSegmentId
    )!
    host.transaction((db) => {
      insertJournalRow(db, 'session-a', {
        kind: 'item',
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch: 'e',
        seq: 2,
        ts: 2,
        fence: 1,
        itemId: 'before-clear',
        revision: 1,
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'captured before clear' }]
        }
      })
      attributeConversationSourceBoundary(db, segment.segmentId, 'session-a', 1, {
        sessionId: 'session-a',
        epoch: 'e',
        endSequence: 2
      })
    })
    for (const sessionId of ['session-a', 'session-b']) {
      const journal = new AgentSessionJournal({
        database: host,
        requiredInTransaction: createConversationOriginRowHook(sessionId),
        identity: {
          sessionId,
          workspaceId: 'folder',
          hostId: 'local',
          agent: 'codex',
          providerHandle: null
        },
        now: () => now + 1
      })
      await journal.open()
      journals.push(journal)
    }
    const current = records.conversations.read(conversation.conversationId)!
    const begun = await records.conversations.clear.begin(
      {
        conversationId: current.conversationId,
        expectedRevision: current.revision,
        expectedContextGeneration: current.contextGeneration,
        expectedActivationFence: current.activationFence
      },
      operation
    )
    for (const sessionId of ['session-a', 'session-b']) {
      await records.transitionHandoff(sessionId, (record) => ({
        ...record,
        lease: { ...record.lease, runtimeFence: 2 }
      }))
    }
    const prepared = await records.conversations.clear.prepare({
      operationKey: begun.intent!.operationKey,
      expectedVersion: begun.intent!.version
    })
    const input = {
      db: host.db,
      scratchDirectory: root,
      conversationId: conversation.conversationId,
      segmentId: segment.segmentId,
      expectedSourceRevision: conversationHistoryRevision(
        host.db,
        conversation.conversationId,
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
        await appendConversationClearJournals({
          journals,
          clear: records.conversations.clear,
          activeSessionId: 'session-a',
          operationKey: prepared.operationKey,
          expectedVersion: prepared.version,
          now: now + 1,
          isCurrent: (journal) => journals.includes(journal)
        })
        return page
      }
    )
    await expect(readConversationHistoricalPage(input)).rejects.toMatchObject({
      reason: 'stale-source'
    })
    expect(acknowledgedItems).toBe(1)
    expect(records.conversations.read(conversation.conversationId)?.contextGeneration).toBe(2)
    expect(
      host.db
        .prepare(
          "SELECT COUNT(*) count FROM journal_epoch_pins WHERE owner_id LIKE 'conversation-presentation:%'"
        )
        .get()?.count
    ).toBe(0)
    expect(readdirSync(root).filter((name) => name.startsWith('conversation-scratch-'))).toEqual([])
  } finally {
    await Promise.all(journals.map((journal) => journal.close()))
    closeTestJournalHostDatabases()
    rmSync(root, { recursive: true, force: true })
  }
})
