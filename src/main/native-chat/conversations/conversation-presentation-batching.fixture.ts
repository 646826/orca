import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  openJournalDatabase,
  runJournalTransaction
} from '../agent-session-journal/journal-database'
import { insertJournalRow } from '../agent-session-journal/journal-row-table'
import { pinJournalEpoch } from '../agent-session-journal/journal-epoch-pins'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { buildConversationPresentationPages } from './conversation-presentation-pages'

const dispose: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const close of dispose.splice(0).toReversed()) {
    close()
  }
})
export function presentationFixture(texts: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'orca-presentation-batch-'))
  const db = openJournalDatabase(join(root, 'source.db')).db
  dispose.push(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  const base = (seq: number) => ({
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: 'e',
    seq,
    ts: seq,
    fence: 1
  })
  const pin = { ownerId: 'original', sessionId: 's', epoch: 'e', endSequence: texts.length + 1 }
  runJournalTransaction(db, () => {
    insertJournalRow(db, 's', {
      ...base(1),
      kind: 'epoch',
      reason: 'session_created',
      providerHandle: { kind: 'codex', threadId: 't' }
    })
    for (const [index, text] of texts.entries()) {
      insertJournalRow(db, 's', {
        ...base(index + 2),
        kind: 'item',
        itemId: `item-${index + 2}`,
        revision: 1,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
      })
    }
    pinJournalEpoch(db, pin)
  })
  return {
    db,
    root,
    pin,
    build: (signal = new AbortController().signal) =>
      buildConversationPresentationPages({
        db,
        pin,
        scratchDirectory: root,
        maxCanonicalBytes: 10_000_000,
        signal
      })
  }
}
export function presentationTransactions(db: Database.Database) {
  const batches: { count: number; bytes: number }[] = []
  const connections = new Set<Database.Database>()
  let priorSequence = 0
  const exec = Database.prototype.exec
  vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql) {
    connections.add(this)
    exec.call(this, sql)
    if (sql !== 'COMMIT') {
      return
    }
    if (this !== db) {
      return
    }
    const row = db
      .prepare(
        'SELECT COUNT(*) count,SUM(byte_length) bytes,MAX(sequence) last FROM conversation_source_versions WHERE sequence>?'
      )
      .get(priorSequence)
    if (typeof row?.last === 'number') {
      batches.push({ count: Number(row.count), bytes: Number(row.bytes) })
      priorSequence = row.last
    }
  })
  return { batches, connections }
}
