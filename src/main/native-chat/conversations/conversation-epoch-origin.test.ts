import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { bindConversationOrigin } from './conversation-origin'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { afterEach, expect, test } from 'vitest'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import {
  createConversationOriginRowHook,
  readConversationRowOrigins
} from './conversation-origin-rows'
import { bindConversationAcquisition } from './conversation-origin-capture'
import { readSegments } from './conversation-read-model'
import { readConversationSourceSpans } from './conversation-source-attribution'
const fixtures: Awaited<ReturnType<typeof createConversationSwitchFixture>>[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.close()
  }
})
test('production replacement and rollover retain fatal original attribution without manual row receipts', async () => {
  const f = await createConversationSwitchFixture('original enrolled text')
  fixtures.push(f)
  const segment = readSegments(
    f.host.db,
    f.records.conversations.intent(f.operationKey)!.conversationId
  ).find((s) => s.sessionId === 'session-a')!
  const origin = {
    conversationId: segment.conversationId,
    segmentId: segment.segmentId,
    contextGeneration: segment.contextGeneration,
    nativeBindingGeneration: segment.nativeBindingGeneration
  }
  f.host.transaction((db) =>
    bindConversationAcquisition(db, { sessionId: 'session-a', fence: 1, origin })
  )
  const journal = await openAgentSessionJournal({
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
  try {
    const identity = {
      provider: 'codex' as const,
      threadId: 'session-a',
      turnId: 'original',
      ordinal: 0
    }
    f.host.transaction((db) =>
      bindConversationOrigin(db, {
        sessionId: 'session-a',
        key: { kind: 'item', id: agentJournalItemKey(identity) },
        origin
      })
    )
    await journal.appendItem(
      identity,
      { kind: 'status', text: 'original owned item' },
      { fence: 1, turnScope: { kind: 'thread' } }
    )
    const before = journal.cursor()
    await journal.replaceEpochItems('unreconcilable_prefix', 1, [
      { identity, body: { kind: 'status', text: 'restated owned item' }, ownerFence: 1 }
    ])
    let replaced = journal.cursor()
    expect(
      readConversationRowOrigins(f.host.db, {
        sessionId: 'session-a',
        epoch: replaced.epoch,
        sequence: 1
      })[0]?.origin
    ).toEqual(origin)
    expect(
      readConversationRowOrigins(f.host.db, {
        sessionId: 'session-a',
        epoch: replaced.epoch,
        sequence: 2
      })[0]?.origin
    ).toEqual(origin)
    expect(
      readConversationSourceSpans(f.host.db, segment.segmentId).some(
        (s) => s.epoch === replaced.epoch
      )
    ).toBe(true)
    expect(
      f.host.db
        .prepare('SELECT 1 FROM journal_rows WHERE session_id=? AND epoch=?')
        .get('session-a', before.epoch)
    ).toBeDefined()
    await expect(
      journal.replaceEpochItems('unreconcilable_prefix', 1, [
        {
          identity,
          body: { kind: 'status', text: 'foreign owner reused identity' },
          ownerFence: 2
        }
      ])
    ).rejects.toThrow('journal replacement item owner changed')
    expect(journal.cursor()).toEqual(replaced)
    const later = {
      ...segment,
      segmentId: 'later-context-segment',
      ordinal: 3,
      contextGeneration: 2,
      nativeBindingGeneration: 2,
      activationFence: 2
    }
    const laterOrigin = {
      conversationId: later.conversationId,
      segmentId: later.segmentId,
      contextGeneration: 2,
      nativeBindingGeneration: 2
    }
    f.host.transaction((db) => {
      db.prepare('INSERT INTO conversation_segments VALUES(?,?,?,?)').run(
        later.segmentId,
        later.conversationId,
        later.ordinal,
        JSON.stringify(later)
      )
      bindConversationAcquisition(db, { sessionId: 'session-a', fence: 2, origin: laterOrigin })
    })
    await journal.replaceEpochItems('unreconcilable_prefix', 2, [
      {
        identity,
        body: { kind: 'status', text: 'old archived fact retained' },
        ownerFence: 1
      }
    ])
    replaced = journal.cursor()
    expect(
      readConversationRowOrigins(f.host.db, {
        sessionId: 'session-a',
        epoch: replaced.epoch,
        sequence: 1
      })[0]?.origin
    ).toEqual(laterOrigin)
    expect(
      readConversationRowOrigins(f.host.db, {
        sessionId: 'session-a',
        epoch: replaced.epoch,
        sequence: 2
      })[0]?.origin
    ).toEqual(origin)
    f.host.db.exec(
      "CREATE TRIGGER refuse_epoch_origin BEFORE INSERT ON conversation_origin_rows BEGIN SELECT RAISE(ABORT,'origin failed'); END"
    )
    await expect(journal.rollEpoch('handle_forked', 2)).rejects.toThrow('origin failed')
    expect(journal.cursor()).toEqual(replaced)
    f.host.db.exec('DROP TRIGGER refuse_epoch_origin')
    await journal.rollEpoch('handle_forked', 2)
    expect(
      readConversationRowOrigins(f.host.db, {
        sessionId: 'session-a',
        epoch: journal.epoch,
        sequence: 1
      })[0]?.origin
    ).toEqual(laterOrigin)
  } finally {
    await journal.close()
  }
})
