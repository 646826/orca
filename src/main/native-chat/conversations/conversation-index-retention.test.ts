import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import {
  openJournalDatabase,
  runJournalTransaction
} from '../agent-session-journal/journal-database'
import {
  appendConversationManifestParts,
  createConversationManifestParts,
  sealConversationManifestParts
} from './conversation-context-parts'
import {
  prepareConversationIndexRetention,
  commitConversationIndexRetention,
  assertConversationIndexRetention
} from './conversation-index-retention'
let db: Database.Database, other: Database.Database, root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-index-pins-'))
  db = openJournalDatabase(join(root, 'db')).db
  other = openJournalDatabase(join(root, 'db')).db
})
afterEach(() => {
  other.close()
  db.close()
  rmSync(root, { recursive: true, force: true })
})
async function index(count = 1) {
  const id = createConversationManifestParts(db, {
    conversationId: 'c',
    contextGeneration: 1,
    sourceRevision: 'revision'
  })
  for (let i = 0; i < count; i++) {
    const epoch = `epoch-${String(i).padStart(4, '0')}`
    db.prepare('INSERT INTO journal_rows(session_id,epoch,seq,ts,row_json) VALUES(?,?,?,?,?)').run(
      'a',
      epoch,
      1,
      1,
      '{}'
    )
    appendConversationManifestParts(db, id, i, [
      {
        version: { source: { sessionId: 'a', epoch, sequence: 1 }, sha256: 'a'.repeat(64) },
        representation: 'missing',
        spans: []
      }
    ])
  }
  return sealConversationManifestParts(db, id, new AbortController().signal)
}
it('records source boundaries, retains each epoch and reuses the immutable index owner', async () => {
  const sealed = await index(2)
  const first = await prepareConversationIndexRetention(db, sealed, new AbortController().signal)
  runJournalTransaction(db, () => commitConversationIndexRetention(db, sealed, first))
  expect(() => assertConversationIndexRetention(db, sealed, first.ownerId)).not.toThrow()
  const again = await prepareConversationIndexRetention(db, sealed, new AbortController().signal)
  expect(again.ownerId).toBe(first.ownerId)
  expect(again.newOwner).toBe(false)
  expect(
    db.prepare('SELECT COUNT(*) n FROM journal_epoch_pins WHERE owner_id=?').get(first.ownerId)?.n
  ).toBe(2)
})
it('invalidates a stale two-connection attempt without deleting the winning owner pins', async () => {
  const sealed = await index()
  const first = prepareConversationIndexRetention(db, sealed, new AbortController().signal)
  const second = prepareConversationIndexRetention(other, sealed, new AbortController().signal)
  await expect(first).rejects.toThrow()
  const winner = await second
  runJournalTransaction(other, () => commitConversationIndexRetention(other, sealed, winner))
  expect(() => assertConversationIndexRetention(db, sealed, winner.ownerId)).not.toThrow()
})
it('resumes an unfinished preparation after a crash and fences the old completion token', async () => {
  const sealed = await index()
  const abandoned = await prepareConversationIndexRetention(
    db,
    sealed,
    new AbortController().signal
  )
  const resumed = await prepareConversationIndexRetention(
    other,
    sealed,
    new AbortController().signal
  )
  expect(resumed.newOwner).toBe(false)
  expect(() =>
    runJournalTransaction(db, () => commitConversationIndexRetention(db, sealed, abandoned))
  ).toThrow()
  runJournalTransaction(other, () => commitConversationIndexRetention(other, sealed, resumed))
  expect(() => assertConversationIndexRetention(db, sealed, resumed.ownerId)).not.toThrow()
})
it('cleans only a new cancelled attempt in bounded batches', async () => {
  const sealed = await index(129)
  const controller = new AbortController()
  setImmediate(() => controller.abort())
  await expect(prepareConversationIndexRetention(db, sealed, controller.signal)).rejects.toThrow()
  expect(db.prepare('SELECT COUNT(*) n FROM journal_epoch_pins').get()?.n).toBe(0)
  expect(db.prepare('SELECT COUNT(*) n FROM conversation_manifest_index_retention').get()?.n).toBe(
    0
  )
})
