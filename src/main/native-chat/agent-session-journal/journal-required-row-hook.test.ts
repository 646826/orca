import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalRow } from './journal-row-schema'
import { JournalRowWriter, type JournalRowTransactionHook } from './journal-row-writer'
import { JournalWriteQueue } from './journal-write-queue'
import {
  openTestJournalHostDatabase,
  publishTestJournalEpoch,
  readTestJournalRows
} from './journal-host-database-test-support'

let root: string, database: JournalHostDatabase
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-required-row-'))
  database = openTestJournalHostDatabase(root)
  publishTestJournalEpoch(database.db, 'session', 'epoch')
  database.db.exec('CREATE TABLE required_origins(sequence INTEGER PRIMARY KEY)')
})
afterEach(async () => {
  database.close()
  await rm(root, { recursive: true, force: true })
})
function row(seq: number, ts: number): JournalRow {
  return {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: 'epoch',
    seq,
    fence: 0,
    ts,
    kind: 'item',
    itemId: `item-${seq}`,
    revision: 1,
    body: { kind: 'status', text: 'evidence' }
  }
}
function writer(requiredInTransaction: JournalRowTransactionHook) {
  const queue = new JournalWriteQueue('session')
  const committed: JournalRow[] = []
  return {
    committed,
    writer: new JournalRowWriter({
      sessionId: 'session',
      now: () => 1,
      serialize: (run) => queue.serialize(run),
      database: () => database,
      readOnly: () => false,
      highestFence: () => 0,
      nextSequence: () => committed.length + 1,
      commit: (rows) => {
        committed.push(...rows)
      },
      requiredInTransaction
    })
  }
}
it('rolls back every final row and origin when the last required hook fails', async () => {
  const value = writer((db, entry) => {
    db.prepare('INSERT INTO required_origins VALUES(?)').run(entry.seq)
    if (entry.seq === 2) {
      throw new Error('Origin binding conflict')
    }
  })
  await expect(value.writer.enqueueRows(() => [row, row])).rejects.toThrow(
    'Origin binding conflict'
  )
  expect(readTestJournalRows(database.db, 'session', 'epoch')).toHaveLength(0)
  expect(database.db.prepare('SELECT * FROM required_origins').all()).toHaveLength(0)
  expect(value.committed).toHaveLength(0)
})
it('requires origin writes for both a single append and every row of a partitioned append', async () => {
  const value = writer((db, entry) => {
    expect(db.isTransaction).toBe(true)
    db.prepare('INSERT INTO required_origins VALUES(?)').run(entry.seq)
  })
  await value.writer.enqueue(row)
  await value.writer.enqueueRows(() => [row, row])
  expect(
    database.db.prepare('SELECT sequence FROM required_origins ORDER BY sequence').all()
  ).toEqual([{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }])
  expect(value.committed).toHaveLength(3)
})
