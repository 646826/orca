import { presentationFixture } from './conversation-presentation-batching.fixture'
import { forwardCompatibleBodies } from './conversation-forward-compatible-items.test-fixture'
import { installScratchWorkerFixture } from './conversation-scratch-worker-setup.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { openJournalDatabase } from '../agent-session-journal/journal-database'
import { insertJournalRow } from '../agent-session-journal/journal-row-table'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { buildConversationPresentationPages } from './conversation-presentation-pages'
test('pages marked bounded tool presentation then next message without rewriting canonical output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-presentation-'))
  const db = openJournalDatabase(join(root, 'journal.db')).db
  const base = (seq: number) => ({
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: 'e',
    seq,
    ts: seq,
    fence: 1
  })
  try {
    insertJournalRow(db, 's', {
      ...base(1),
      kind: 'epoch',
      reason: 'session_created',
      providerHandle: { kind: 'codex', threadId: 't' }
    })
    insertJournalRow(db, 's', {
      ...base(2),
      kind: 'item',
      itemId: 'tool',
      revision: 1,
      body: {
        kind: 'tool-call',
        name: 'shell',
        input: {},
        state: 'completed',
        output: {
          head: 'large🙂'.repeat(200000),
          byteLength: 1800000,
          digest: 'a'.repeat(64),
          truncated: false
        }
      }
    })
    insertJournalRow(db, 's', {
      ...base(3),
      kind: 'item',
      itemId: 'next',
      revision: 1,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'next message' }] }
    })
    const raw = db.prepare('SELECT row_json FROM journal_rows WHERE seq=2').get()?.row_json
    const result = await buildConversationPresentationPages({
      db,
      pin: { ownerId: 'test', sessionId: 's', epoch: 'e', endSequence: 3 },
      scratchDirectory: root,
      maxCanonicalBytes: 10_000_000,
      signal: new AbortController().signal
    })
    expect(result.kind).toBe('built')
    if (result.kind !== 'built') {
      return
    }
    try {
      const first = await result.lease.itemPage(null, 1, 512 * 1024)
      expect(first.items[0]?.shortened).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(512 * 1024)
      const next = await result.lease.itemPage(first.next, 1, 512 * 1024)
      expect(next.items[0]?.itemId).toBe('next')
      expect('originalPage' in result.lease).toBe(false)
      expect(db.prepare('SELECT row_json FROM journal_rows WHERE seq=2').get()?.row_json).toBe(raw)
    } finally {
      await result.lease.close()
    }
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

installScratchWorkerFixture()

test('preserves forward-compatible body and block payloads across the real replay worker', async () => {
  const f = presentationFixture([])
  for (const [index, body] of forwardCompatibleBodies.entries()) {
    const seq = index + 2
    f.db
      .prepare('INSERT INTO journal_rows(session_id,epoch,seq,ts,row_json) VALUES(?,?,?,?,?)')
      .run(
        's',
        'e',
        seq,
        seq,
        JSON.stringify({
          v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
          epoch: 'e',
          seq,
          ts: seq,
          fence: 1,
          kind: 'item',
          itemId: `future-${seq}`,
          revision: 1,
          body
        })
      )
  }
  const result = await buildConversationPresentationPages({
    db: f.db,
    pin: { ...f.pin, endSequence: 4 },
    scratchDirectory: f.root,
    maxCanonicalBytes: 1_000_000,
    signal: new AbortController().signal
  })
  if (result.kind !== 'built') {
    throw new Error(result.reason)
  }
  try {
    const page = await result.lease.itemPage(null, 128)
    expect(page.items.map((item) => item.body)).toEqual(forwardCompatibleBodies)
  } finally {
    await result.lease.close()
  }
})
