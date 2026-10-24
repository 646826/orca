import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabases
} from '../agent-session-journal/journal-host-database-test-support'
import { pruneConversationArchiveEpoch } from './conversation-archive-prune'

it('prunes at most 128 retired rows per transaction', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-archive-prune-'))
  try {
    const host = openTestJournalHostDatabase(root)
    host.transaction((db) => {
      // Storage-only fixture: no native acceptance or conversation authority is inferred from these rows.
      db.prepare('INSERT INTO conversations VALUES(?,?)').run('conversation', '{}')
      db.prepare(
        "INSERT INTO conversation_archive_deletions(operation_key,conversation_id,context_generation,phase) VALUES(?,?,1,'cleanup')"
      ).run('delete', 'conversation')
      db.prepare('INSERT INTO conversation_archive_epochs VALUES(?,?,?)').run(
        'delete',
        'source',
        'retired'
      )
      for (let seq = 1; seq <= 300; seq++) {
        db.prepare('INSERT INTO journal_rows VALUES(?,?,?,?,?)').run(
          'source',
          'retired',
          seq,
          1,
          '{}'
        )
      }
    })
    expect(host.transaction((db) => pruneConversationArchiveEpoch(db, 'delete'))).toBe(false)
    expect(host.db.prepare('SELECT COUNT(*) count FROM journal_rows').get()?.count).toBe(172)
    host.transaction((db) => pruneConversationArchiveEpoch(db, 'delete'))
    expect(host.db.prepare('SELECT COUNT(*) count FROM journal_rows').get()?.count).toBe(44)
    host.transaction((db) => pruneConversationArchiveEpoch(db, 'delete'))
    expect(host.transaction((db) => pruneConversationArchiveEpoch(db, 'delete'))).toBe(true)
  } finally {
    closeTestJournalHostDatabases()
    rmSync(root, { recursive: true, force: true })
  }
})
