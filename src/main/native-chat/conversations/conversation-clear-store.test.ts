import { appendConversationClearJournals } from './conversation-clear-journals'
import { appendJournalHostCompound } from '../agent-session-journal/journal-host-compound-writes'
import { assertQueuedDraftCurrentGeneration } from '../agent-session-journal/queued-message-origin'
import { conversationHistoryRevision, readConversationHistoricalPage } from './conversation-history'
import { createClearStoreFixture, now, operation } from './conversation-clear-store.fixture'
import { readConversationSegmentPage } from './conversation-segment-page'
import {
  createConversationOriginRowHook,
  readConversationRowOrigins
} from './conversation-origin-rows'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { closeTestJournalHostDatabases } from '../agent-session-journal/journal-host-database-test-support'

let root: string | undefined
const opened: AgentSessionJournal[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((journal) => journal.close()))
  closeTestJournalHostDatabases()
  if (root) {
    rmSync(root, { recursive: true, force: true })
  }
})
it.each([false, true])(
  'clears all released participants atomically (injected failure: %s)',
  async (failCommit) => {
    root = mkdtempSync(join(tmpdir(), 'orca-aggregate-clear-'))
    const { host, records, conversation } = await createClearStoreFixture(root)
    const request = {
      conversationId: conversation.conversationId,
      expectedRevision: conversation.revision,
      expectedContextGeneration: 1,
      expectedActivationFence: 1
    }
    const begun = await records.conversations.clear.begin(request, operation)
    expect(begun.intent).toMatchObject({
      phase: 'quiescing',
      contextGeneration: 1,
      participants: [
        { sessionId: 'session-a', runtimeFence: 1, nativeBindingGeneration: 1 },
        { sessionId: 'session-b', runtimeFence: 1, nativeBindingGeneration: 1 }
      ]
    })
    expect(records.conversations.route('session-a')).toMatchObject({
      mutation: 'clear',
      role: 'active'
    })
    const again = await records.conversations.clear.begin(request, operation)
    expect(again.intent).toEqual(begun.intent)
    expect(records.conversations.read(conversation.conversationId)?.contextGeneration).toBe(1)
    await expect(
      records.conversations.clear.begin(
        { ...request, expectedRevision: conversation.revision + 1 },
        { ...operation, operationId: `${now}-${'d'.repeat(32)}` }
      )
    ).rejects.toThrow('busy')
    const journal = new AgentSessionJournal({
      database: host,
      requiredInTransaction: createConversationOriginRowHook('session-a'),
      identity: {
        sessionId: 'session-a',
        workspaceId: 'folder',
        hostId: 'local',
        agent: 'codex',
        providerHandle: null
      },
      now: () => now + 1
    })
    await journal.open()
    opened.push(journal)
    const parked = new AgentSessionJournal({
      database: host,
      requiredInTransaction: createConversationOriginRowHook('session-b'),
      identity: {
        sessionId: 'session-b',
        workspaceId: 'folder',
        hostId: 'local',
        agent: 'codex',
        providerHandle: null
      },
      now: () => now + 1
    })
    await parked.open()
    opened.push(parked)
    for (const participant of [journal, parked]) {
      await participant.queuedMessages.insert({
        messageId: 'old-draft',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'original generation' }]
        }
      })
    }
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
    const boundary = records.conversations.clear.boundary(prepared.operationKey, now + 1)
    const commit = () =>
      appendConversationClearJournals({
        journals: [journal, parked],
        clear: records.conversations.clear,
        activeSessionId: 'session-a',
        operationKey: prepared.operationKey,
        expectedVersion: prepared.version,
        now: now + 1,
        isCurrent: (current) => current === journal || current === parked
      })
    if (failCommit) {
      host.db.exec(
        `CREATE TRIGGER inject_clear_failure BEFORE UPDATE ON conversation_clear_intents WHEN json_extract(NEW.record_json,'$.phase')='committed' BEGIN SELECT RAISE(ABORT,'injected durable failure'); END`
      )
      await expect(commit()).rejects.toThrow()
      expect(records.conversations.read(conversation.conversationId)?.contextGeneration).toBe(1)
      expect(journal.queuedMessages.get('old-draft')?.holdReason).toBeNull()
      expect(parked.queuedMessages.get('old-draft')?.holdReason).toBeNull()
      for (const sessionId of ['session-a', 'session-b']) {
        expect(records.getRecord(sessionId)?.providerHandleChain).toHaveLength(1)
        expect(records.conversations.membership(sessionId)?.contextGeneration).toBe(1)
      }
      expect(
        host.db.prepare('SELECT COUNT(*) AS count FROM conversation_clear_rows').get()?.count
      ).toBe(0)
      expect(
        host.db
          .prepare('SELECT MAX(seq) AS seq FROM journal_rows WHERE session_id=? AND epoch=?')
          .get('session-a', prepared.sourceBoundaries[0]!.epoch)?.seq
      ).toBe(prepared.sourceBoundaries[0]!.endSequence)
      return
    }
    let bothAdopted = false
    journal.observeCommits(() => {
      bothAdopted =
        parked.queuedMessages.get('old-draft')?.holdReason === 'context_generation_changed' &&
        records.conversations.membership('session-b')?.contextGeneration === 2
    })
    await commit()
    expect(bothAdopted).toBe(true)
    expect(boundary.afterFence).toBe(2)
    expect(
      host.db
        .prepare(
          "SELECT json_extract(row_json,'$.fence') fence FROM journal_rows WHERE session_id=? AND epoch=? ORDER BY seq DESC LIMIT 1"
        )
        .get('session-a', journal.cursor().epoch)?.fence
    ).toBe(1)
    for (const participant of [journal, parked]) {
      expect(participant.queuedMessages.get('old-draft')?.holdReason).toBe(
        'context_generation_changed'
      )
      expect(() =>
        assertQueuedDraftCurrentGeneration(host.db, {
          sessionId: participant.queuedMessages.sessionId,
          messageId: 'old-draft'
        })
      ).toThrow()
    }
    expect(records.conversations.read(conversation.conversationId)).toMatchObject({
      contextGeneration: 2,
      activationFence: 2,
      pendingOperationKey: null
    })
    expect(records.getRecord('session-a')).toMatchObject({
      providerHandleChain: [],
      providerContextBoundary: boundary
    })
    expect(records.conversations.membership('session-a')).toMatchObject({
      contextGeneration: 2,
      nativeBindingGeneration: 2
    })
    expect(records.getRecord('session-b')).toMatchObject({
      providerHandleChain: [],
      providerContextBoundary: boundary
    })
    expect(records.conversations.membership('session-b')).toMatchObject({
      contextGeneration: 2,
      nativeBindingGeneration: 2,
      state: 'parked'
    })
    expect(records.conversations.segments(conversation.conversationId)).toHaveLength(3)
    expect(
      readConversationRowOrigins(host.db, {
        sessionId: 'session-a',
        epoch: prepared.sourceBoundaries[0]!.epoch,
        sequence: prepared.sourceBoundaries[0]!.endSequence + 1
      })
    ).toMatchObject([{ origin: { contextGeneration: 1, segmentId: conversation.activeSegmentId } }])
    const current = records.conversations.read(conversation.conversationId)!
    expect(
      await readConversationHistoricalPage({
        db: host.db,
        scratchDirectory: root!,
        conversationId: current.conversationId,
        segmentId: current.activeSegmentId,
        expectedSourceRevision: conversationHistoryRevision(
          host.db,
          current.conversationId,
          current.activeSegmentId
        ),
        after: null,
        limit: 1,
        signal: new AbortController().signal
      })
    ).toMatchObject({ status: 'complete', items: [] })

    await appendJournalHostCompound(
      [journal, parked],
      () => ({
        appends: [
          {
            journal,
            ...journal.planSubmission({
              clientMessageId: 'after-clear',
              payloadFingerprint: 'current-intention',
              body: {
                kind: 'message',
                role: 'user',
                blocks: [{ type: 'text', text: 'new generation' }]
              },
              fence: 2
            })
          }
        ]
      }),
      { isCurrent: (entry) => entry === journal || entry === parked }
    )
    expect(journal.submission('after-clear')?.queuedMessageId).toBeUndefined()
    expect(journal.submission('after-clear')).not.toBeNull()

    host.db.prepare('INSERT INTO conversation_context_manifests VALUES(?,?,NULL,?)').run(
      'old-payload',
      JSON.stringify({
        conversationId: current.conversationId,
        contextGeneration: 1,
        digest: 'a'.repeat(64),
        projection: [{ text: 'private retired payload' }]
      }),
      '{}'
    )

    host.db.prepare('INSERT INTO conversation_context_manifests VALUES(?,?,NULL,?)').run(
      'current-payload',
      JSON.stringify({
        conversationId: current.conversationId,
        contextGeneration: 2,
        digest: 'b'.repeat(64),
        projection: [{ text: 'keep current payload' }]
      }),
      '{}'
    )
    const archive = await records.conversations.archive.remove(
      {
        conversationId: current.conversationId,
        expectedRevision: current.revision,
        contextGeneration: 1
      },
      { ...operation, operationId: `${now}-${'f'.repeat(32)}`, fingerprint: 'archive' },
      () => {}
    )
    expect(
      readConversationSegmentPage(host.db, current.conversationId, null, 128).segments.every(
        (s) => s.contextGeneration === 2
      )
    ).toBe(true)
    let complete = false
    for (let batch = 0; batch < 100 && !complete; batch++) {
      complete = (await records.conversations.archive.cleanup(archive, () => {})).complete
    }
    expect(complete).toBe(true)
    expect(records.conversations.archive.status(current.conversationId, 1)).toMatchObject({
      operationKey: archive.operationKey,
      phase: 'complete'
    })
    await expect(
      records.conversations.archive.cleanup({ ...archive, conversationId: 'foreign' }, () => {})
    ).rejects.toThrow('missing-record')
    expect(
      host.db
        .prepare('SELECT 1 FROM conversation_context_manifests WHERE manifest_id=?')
        .get('current-payload')
    ).toBeDefined()
    expect(
      host.db
        .prepare(
          'SELECT metadata_json FROM conversation_archive_audit WHERE operation_key=? AND kind=? AND evidence_id=?'
        )
        .get(archive.operationKey, 'manifest', 'old-payload')?.metadata_json
    ).toBe(JSON.stringify({ digest: 'a'.repeat(64) }))
    await expect(
      records.conversations.archive.remove(
        {
          conversationId: current.conversationId,
          expectedRevision: current.revision,
          contextGeneration: 1
        },
        { ...operation, operationId: `${now}-${'f'.repeat(32)}`, fingerprint: 'forged' },
        () => {}
      )
    ).rejects.toThrow()

    expect(
      host.db
        .prepare('SELECT 1 FROM conversation_context_manifests WHERE manifest_id=?')
        .get('old-payload')
    ).toBeUndefined()
    expect(
      host.db
        .prepare('SELECT COUNT(*) AS count FROM journal_epoch_pins WHERE owner_id=?')
        .get(`conversation-segment:${conversation.activeSegmentId}:initial`)?.count
    ).toBe(0)
    expect(
      host.db
        .prepare('SELECT COUNT(*) AS count FROM journal_rows WHERE session_id=?')
        .get('session-a')?.count
    ).toBeGreaterThan(0)
    await expect(
      records.conversations.archive.remove(
        {
          conversationId: current.conversationId,
          expectedRevision: current.revision,
          contextGeneration: 2
        },
        { ...operation, operationId: `${now}-${'9'.repeat(32)}`, fingerprint: 'archive-current' },
        () => {}
      )
    ).rejects.toThrow()
  }
)

it('rejects same-session journal handles from another host before any clear state escapes rollback', async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-cross-host-clear-'))
  const first = await createClearStoreFixture(join(root, 'first'))
  const other = await createClearStoreFixture(join(root, 'other'))
  const begun = await first.records.conversations.clear.begin(
    {
      conversationId: first.conversation.conversationId,
      expectedRevision: first.conversation.revision,
      expectedContextGeneration: 1,
      expectedActivationFence: 1
    },
    operation
  )
  const prepared = await first.records.conversations.clear.prepare({
    operationKey: begun.intent!.operationKey,
    expectedVersion: begun.intent!.version
  })
  const journals = await Promise.all(
    ['session-a', 'session-b'].map(async (sessionId) => {
      const journal = new AgentSessionJournal({
        database: other.host,
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
      opened.push(journal)
      return journal
    })
  )
  const before = journals.map((journal) => journal.cursor())
  await expect(
    appendConversationClearJournals({
      journals,
      clear: first.records.conversations.clear,
      activeSessionId: 'session-a',
      operationKey: prepared.operationKey,
      expectedVersion: prepared.version,
      now: now + 1,
      isCurrent: (journal) => journals.includes(journal)
    })
  ).rejects.toThrow('crossed host databases')
  expect(journals.map((journal) => journal.cursor())).toEqual(before)
  expect(
    first.records.conversations.read(first.conversation.conversationId)?.contextGeneration
  ).toBe(1)
  expect(
    other.records.conversations.read(other.conversation.conversationId)?.contextGeneration
  ).toBe(1)
  expect(first.host.db.prepare('SELECT 1 FROM conversation_clear_rows').get()).toBeUndefined()
  expect(other.host.db.prepare('SELECT 1 FROM conversation_clear_rows').get()).toBeUndefined()
})
