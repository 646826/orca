import { JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { openJournalDatabase, runJournalTransaction } from './journal-database'
import { openJournalDatabase as openVersion4Database } from './journal-database-v4.fixture'
import { pinJournalEpoch } from './journal-epoch-pins'
import { insertJournalRow, readJournalRowsAfter } from './journal-row-table'

describe('retention schema downgrade', () => {
  let root: string
  let path: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-pin-downgrade-'))
    path = join(root, 'journal.db')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('does not change a version-4 database when migration admission refuses', () => {
    openVersion4Database(path).db.close()
    const before = readFileSync(path)
    expect(() =>
      openJournalDatabase(path, () => {
        throw new Error('another runtime owns the profile')
      })
    ).toThrow('another runtime owns the profile')
    expect(readFileSync(path)).toEqual(before)
  })

  it('rechecks the schema inside the migration barrier before any writable initialization', () => {
    openVersion4Database(path).db.close()
    let before = readFileSync(path)
    const opened = openJournalDatabase(path, (run) => {
      const concurrent = openVersion4Database(path)
      concurrent.db.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 1}`)
      concurrent.db.pragma('wal_checkpoint(TRUNCATE)')
      concurrent.db.close()
      before = readFileSync(path)
      run()
    })
    expect(opened.readOnly).toBe(true)
    opened.db.close()
    expect(readFileSync(path)).toEqual(before)
  })

  it('refuses an admission callback that does not run migration synchronously', () => {
    openVersion4Database(path).db.close()
    const before = readFileSync(path)
    expect(() => openJournalDatabase(path, () => undefined)).toThrow(/synchronous/i)
    expect(readFileSync(path)).toEqual(before)
  })

  it('migrates a real version-4 database and the old opener cannot change its bytes', () => {
    const old = openVersion4Database(path)
    expect(old.db.pragma('user_version', { simple: true })).toBe(4)
    insertJournalRow(old.db, 'session-a', {
      kind: 'epoch',
      reason: 'session_created',
      epoch: 'epoch-a',
      seq: 1,
      ts: 1,
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      fence: 1,
      providerHandle: { kind: 'codex', threadId: 'thread-a' }
    })
    old.db.close()
    const migrated = openJournalDatabase(path)
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(JOURNAL_DB_SCHEMA_VERSION)
    runJournalTransaction(migrated.db, () =>
      pinJournalEpoch(migrated.db, {
        ownerId: 'manifest-a',
        sessionId: 'session-a',
        epoch: 'epoch-a',
        endSequence: 1
      })
    )
    migrated.db.close()
    const before = readFileSync(path)
    const reopenedOld = openVersion4Database(path)
    try {
      expect(reopenedOld.readOnly).toBe(true)
      expect(readJournalRowsAfter(reopenedOld.db, 'session-a', 'epoch-a', 0)).toHaveLength(1)
      expect(() => reopenedOld.db.exec('DELETE FROM journal_rows')).toThrow(/readonly/i)
      expect(() => reopenedOld.db.exec('DELETE FROM agent_session_records')).toThrow(/readonly/i)
    } finally {
      reopenedOld.db.close()
    }
    expect(readFileSync(path)).toEqual(before)
  })

  it('guards pinned evidence even on a connection opened before migration', () => {
    const old = openVersion4Database(path)
    insertJournalRow(old.db, 'session-a', {
      kind: 'epoch',
      reason: 'session_created',
      epoch: 'epoch-a',
      seq: 1,
      ts: 1,
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      fence: 1,
      providerHandle: { kind: 'codex', threadId: 'thread-a' }
    })
    const migrated = openJournalDatabase(path)
    try {
      runJournalTransaction(migrated.db, () =>
        pinJournalEpoch(migrated.db, {
          ownerId: 'manifest-a',
          sessionId: 'session-a',
          epoch: 'epoch-a',
          endSequence: 1
        })
      )
      expect(() => old.db.exec('DELETE FROM journal_rows')).toThrow(/pinned/i)
      expect(() => old.db.exec('UPDATE journal_rows SET ts = 2')).toThrow(/pinned/i)
      expect(readJournalRowsAfter(migrated.db, 'session-a', 'epoch-a', 0)[0]?.ts).toBe(1)
    } finally {
      old.db.close()
      migrated.db.close()
    }
  })
})
