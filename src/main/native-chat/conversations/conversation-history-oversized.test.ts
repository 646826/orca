import { installScratchWorkerFixture } from './conversation-scratch-worker-setup.test-fixture'
import { expect, test } from 'vitest'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import { readSegments } from './conversation-read-model'
import { insertJournalRow } from '../agent-session-journal/journal-row-table'
import { attributeConversationSourceBoundary } from './conversation-source-attribution'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { conversationHistoryRevision, readConversationHistoricalPage } from './conversation-history'

test('oversized tool presentation is marked and does not strand the next message or change captured bytes', async () => {
  const f = await createConversationSwitchFixture()
  try {
    const intent = f.records.conversations.intent(f.operationKey)!
    const segment = readSegments(f.host.db, intent.conversationId).find(
      (s) => s.sessionId === 'session-a'
    )!
    const output = 'captured output\n'.repeat(100_000)
    f.host.transaction((db) => {
      insertJournalRow(db, 'session-a', {
        kind: 'item',
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch: 'epoch-session-a',
        seq: 2,
        ts: 2,
        fence: 1,
        itemId: 'codex:tool:large',
        revision: 1,
        body: {
          kind: 'tool-call',
          name: 'read',
          input: {},
          state: 'completed',
          output: {
            head: output,
            byteLength: Buffer.byteLength(output),
            digest: 'a'.repeat(64),
            truncated: false
          }
        }
      })
      insertJournalRow(db, 'session-a', {
        kind: 'item',
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch: 'epoch-session-a',
        seq: 3,
        ts: 3,
        fence: 1,
        itemId: 'codex:message:after',
        revision: 1,
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'after large tool' }]
        }
      })
      for (const endSequence of [2, 3]) {
        attributeConversationSourceBoundary(db, segment.segmentId, 'session-a', 1, {
          sessionId: 'session-a',
          epoch: 'epoch-session-a',
          endSequence
        })
      }
    })
    const raw = () =>
      f.host.db
        .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq=2')
        .get('session-a', 'epoch-session-a')?.row_json
    const before = raw()
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
    expect(first.items[0]?.item.shortened).toBe(true)
    expect(first.items[0]?.originSource).toEqual({
      sessionId: 'session-a',
      epoch: 'epoch-session-a',
      sequence: 2
    })
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(512 * 1024)
    const next = await readConversationHistoricalPage({ ...input, after: first.next })
    expect(next.status).toBe('complete')
    expect(JSON.stringify(next.items)).toContain('after large tool')
    expect(raw()).toBe(before)
    expect(typeof before === 'string' && before.includes(JSON.stringify(output).slice(1, -1))).toBe(
      true
    )
  } finally {
    f.close()
  }
})

installScratchWorkerFixture()
