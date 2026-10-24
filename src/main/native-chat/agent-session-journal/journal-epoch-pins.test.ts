import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { openJournalDatabase, runJournalTransaction } from './journal-database'
import { JournalHostDatabase, journalDatabasePath } from './journal-host-database'
import { publishNewEpoch } from './journal-epoch-rollover'
import { replaceJournalEpoch } from './journal-epoch-replacement'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  iteratePinnedJournalEpochRows,
  pinJournalEpoch,
  releaseJournalEpochPins
} from './journal-epoch-pins'
import {
  deleteJournalEpochRows,
  insertJournalRow,
  publishJournalSessionEpoch,
  readJournalRowsAfter,
  readJournalSessionEpoch
} from './journal-row-table'

describe('journal epoch retention pins', () => {
  let root: string
  let db: Database.Database

  function append(sequence: number, epoch = 'epoch-a'): void {
    insertJournalRow(db, 'session-a', {
      kind: 'epoch',
      reason: 'session_created',
      providerHandle: { kind: 'codex', threadId: 'thread-a' },
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      epoch,
      seq: sequence,
      fence: 1,
      ts: sequence
    })
  }

  const request = {
    ownerId: 'manifest-a',
    sessionId: 'session-a',
    epoch: 'epoch-a',
    endSequence: 2
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-epoch-pins-'))
    db = openJournalDatabase(journalDatabasePath(root)).db
    append(1)
    append(2)
    publishJournalSessionEpoch(
      db,
      { sessionId: 'session-a', workspaceId: 'workspace-a' },
      'epoch-a'
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('retains the whole retired epoch across restart and freezes the historical end', () => {
    const pin = runJournalTransaction(db, () => pinJournalEpoch(db, request))
    append(3)
    runJournalTransaction(db, () => {
      deleteJournalEpochRows(db, 'session-a', 'epoch-a')
      append(1, 'epoch-b')
      publishJournalSessionEpoch(
        db,
        { sessionId: 'session-a', workspaceId: 'workspace-a' },
        'epoch-b'
      )
    })
    db.close()
    db = openJournalDatabase(journalDatabasePath(root)).db
    expect(readJournalSessionEpoch(db, 'session-a')).toBe('epoch-b')
    expect(readJournalRowsAfter(db, 'session-a', 'epoch-a', 0)).toHaveLength(3)
    expect([...iteratePinnedJournalEpochRows(db, pin)].map((row) => row.seq)).toEqual([1, 2])
  })

  it.each(['rollover', 'replacement'])(
    'preserves pinned evidence through actual %s publication',
    (mode) => {
      const pin = runJournalTransaction(db, () => pinJournalEpoch(db, request))
      const database = JournalHostDatabase.open(root)
      const identity = {
        sessionId: 'session-a',
        workspaceId: 'workspace-a',
        hostId: 'host-a',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-a')
      }
      try {
        if (mode === 'rollover') {
          publishNewEpoch({
            queue: { cards: [], receipt: { write: () => {}, committed: () => {} } },
            database,
            identity,
            epoch: 'epoch-b',
            reason: 'session_created',
            fence: 2,
            now: 5,
            onPublished: () => undefined
          })
        } else {
          replaceJournalEpoch({
            queue: { cards: [], receipt: { write: () => {}, committed: () => {} } },
            database,
            identity,
            reason: 'legacy_import',
            fence: 2,
            items: [],
            queuePause: { lifted: false, liveStop: null, reopened: false },
            now: () => 5,
            mintEpoch: () => 'epoch-b',
            onPublished: () => undefined
          })
        }
        expect(readJournalSessionEpoch(db, 'session-a')).toBe('epoch-b')
        expect([...iteratePinnedJournalEpochRows(db, pin)].map((row) => row.seq)).toEqual([1, 2])
      } finally {
        database.close()
      }
    }
  )

  it('requires a transaction and refuses unavailable or gapped prefixes', () => {
    expect(() => pinJournalEpoch(db, request)).toThrow(/transaction/i)
    expect(() =>
      runJournalTransaction(db, () => pinJournalEpoch(db, { ...request, endSequence: 3 }))
    ).toThrow(/prefix/i)
    db.prepare('DELETE FROM journal_rows WHERE seq = 1').run()
    expect(() => runJournalTransaction(db, () => pinJournalEpoch(db, request))).toThrow(/prefix/i)
  })

  it('retains corrupt captured bytes without certifying that the compiler can interpret them', () => {
    db.prepare("UPDATE journal_rows SET row_json = '{}' WHERE seq = 2").run()
    const pin = runJournalTransaction(db, () => pinJournalEpoch(db, request))
    expect([...iteratePinnedJournalEpochRows(db, pin)][1]?.rowJson).toBe('{}')
  })

  it('keeps owner bindings immutable and rejects a conflicting replay', () => {
    runJournalTransaction(db, () => pinJournalEpoch(db, request))
    expect(runJournalTransaction(db, () => pinJournalEpoch(db, request))).toEqual(request)
    expect(() =>
      runJournalTransaction(db, () => pinJournalEpoch(db, { ...request, endSequence: 1 }))
    ).toThrow(/conflict/i)
  })

  it('releases only the requested owner and collects a retired epoch after its last owner', () => {
    runJournalTransaction(db, () => {
      pinJournalEpoch(db, request)
      pinJournalEpoch(db, { ...request, ownerId: 'manifest-b' })
      publishJournalSessionEpoch(
        db,
        { sessionId: 'session-a', workspaceId: 'workspace-a' },
        'epoch-b'
      )
      releaseJournalEpochPins(db, 'manifest-a')
    })
    expect(readJournalRowsAfter(db, 'session-a', 'epoch-a', 0)).toHaveLength(2)
    runJournalTransaction(db, () => releaseJournalEpochPins(db, 'manifest-b'))
    expect(readJournalRowsAfter(db, 'session-a', 'epoch-a', 0)).toEqual([])
    expect(() => [...iteratePinnedJournalEpochRows(db, request)]).toThrow(/pin/i)
  })

  it('does not collect a live epoch when its final pin is released', () => {
    runJournalTransaction(db, () => {
      pinJournalEpoch(db, request)
      releaseJournalEpochPins(db, request.ownerId)
    })
    expect(readJournalRowsAfter(db, 'session-a', 'epoch-a', 0)).toHaveLength(2)
  })

  it('rolls pin creation back with its enclosing durable operation', () => {
    expect(() =>
      runJournalTransaction(db, () => {
        pinJournalEpoch(db, request)
        throw new Error('failed operation')
      })
    ).toThrow('failed operation')
    deleteJournalEpochRows(db, 'session-a', 'epoch-a')
    expect(readJournalRowsAfter(db, 'session-a', 'epoch-a', 0)).toEqual([])
  })

  it('never acknowledges a pin when the durable commit fails', () => {
    const exec = db.exec.bind(db)
    vi.spyOn(db, 'exec').mockImplementation((sql) => {
      if (sql === 'COMMIT') {
        throw new Error('disk full at commit')
      }
      exec(sql)
    })
    expect(() => runJournalTransaction(db, () => pinJournalEpoch(db, request))).toThrow(
      'disk full at commit'
    )
    expect(db.isTransaction).toBe(false)
    expect(() => [...iteratePinnedJournalEpochRows(db, request)]).toThrow(/pin/i)
    deleteJournalEpochRows(db, 'session-a', 'epoch-a')
    expect(readJournalRowsAfter(db, 'session-a', 'epoch-a', 0)).toEqual([])
  })

  it('pages through only the frozen prefix and detects a later-page gap', () => {
    for (let sequence = 3; sequence <= 260; sequence += 1) {
      append(sequence)
    }
    const pin = runJournalTransaction(db, () =>
      pinJournalEpoch(db, { ...request, endSequence: 259 })
    )
    expect([...iteratePinnedJournalEpochRows(db, pin)].map((row) => row.seq)).toEqual(
      Array.from({ length: 259 }, (_, index) => index + 1)
    )
    db.exec('DROP TRIGGER journal_pinned_epoch_delete')
    db.prepare('DELETE FROM journal_rows WHERE seq = 129').run()
    expect(() => [...iteratePinnedJournalEpochRows(db, pin)]).toThrow(/prefix/i)
  })

  it('rejects stale raw SQL deletion, mutation and replacement of pinned evidence', () => {
    const stale = openJournalDatabase(journalDatabasePath(root)).db
    try {
      runJournalTransaction(db, () => pinJournalEpoch(db, request))
      expect(() =>
        stale.prepare('DELETE FROM journal_rows WHERE session_id = ?').run('session-a')
      ).toThrow(/pinned/i)
      expect(() => stale.prepare('UPDATE journal_rows SET ts = 9 WHERE seq = 2').run()).toThrow(
        /pinned/i
      )
      expect(() =>
        stale.exec(
          'INSERT OR REPLACE INTO journal_rows SELECT session_id, epoch, seq, 9, row_json FROM journal_rows WHERE seq = 2'
        )
      ).toThrow(/pinned/i)
      append(2, 'epoch-unpinned')
      expect(() =>
        stale
          .prepare(
            "UPDATE OR REPLACE journal_rows SET epoch = 'epoch-a' WHERE epoch = 'epoch-unpinned'"
          )
          .run()
      ).toThrow(/pinned/i)
      expect(readJournalRowsAfter(db, 'session-a', 'epoch-a', 0).map((row) => row.ts)).toEqual([
        1, 2
      ])
    } finally {
      stale.close()
    }
  })
})
