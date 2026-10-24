import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import type Database from '../../sqlite/sync-database'
import {
  pinJournalEpoch,
  releaseJournalEpochPin
} from '../agent-session-journal/journal-epoch-pins'
import { runJournalTransaction } from '../agent-session-journal/journal-transaction'
import type { ConversationManifestPartIndex } from './conversation-context-parts'
import {
  assertConversationAuthorityRevision,
  readConversationAuthorityRevision
} from './conversation-context-authority-revision'

export type ConversationIndexRetentionAttempt = {
  indexId: string
  ownerId: string
  attemptId: string
  newOwner: boolean
  authorityRevision: number
}
export function createConversationIndexRetentionTablesSql(): string {
  return `CREATE TABLE IF NOT EXISTS conversation_manifest_source_boundaries (
    index_id TEXT NOT NULL REFERENCES conversation_manifest_part_indexes(index_id),
    session_id TEXT NOT NULL,epoch TEXT NOT NULL,end_sequence INTEGER NOT NULL,
    PRIMARY KEY(index_id,session_id,epoch)
  );
  CREATE TABLE IF NOT EXISTS conversation_manifest_index_retention (
    index_id TEXT PRIMARY KEY REFERENCES conversation_manifest_part_indexes(index_id),owner_id TEXT NOT NULL UNIQUE,
    root_digest TEXT NOT NULL,part_count INTEGER NOT NULL,attempt_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('preparing','retained'))
  );
  CREATE TRIGGER IF NOT EXISTS conversation_manifest_boundaries_sealed_update BEFORE UPDATE ON conversation_manifest_source_boundaries
  WHEN EXISTS(SELECT 1 FROM conversation_manifest_part_indexes WHERE index_id=OLD.index_id AND root_digest IS NOT NULL)
  BEGIN SELECT RAISE(ABORT,'sealed source boundary is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS conversation_manifest_boundaries_sealed_insert BEFORE INSERT ON conversation_manifest_source_boundaries
  WHEN EXISTS(SELECT 1 FROM conversation_manifest_part_indexes WHERE index_id=NEW.index_id AND root_digest IS NOT NULL)
  BEGIN SELECT RAISE(ABORT,'sealed source boundary is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS conversation_manifest_boundaries_no_delete BEFORE DELETE ON conversation_manifest_source_boundaries
  WHEN EXISTS(SELECT 1 FROM conversation_manifest_compilations WHERE index_id=OLD.index_id)
  BEGIN SELECT RAISE(ABORT,'compiled source boundary is immutable'); END;`
}
function assertIndex(db: Database.Database, index: ConversationManifestPartIndex): void {
  const stored = db
    .prepare(
      'SELECT root_digest,part_count FROM conversation_manifest_part_indexes WHERE index_id=?'
    )
    .get(index.indexId)
  if (stored?.root_digest !== index.rootDigest || stored.part_count !== index.partCount) {
    throw new Error('Retention index changed')
  }
}
function assertAttempt(db: Database.Database, attempt: ConversationIndexRetentionAttempt): void {
  const row = db
    .prepare(
      'SELECT owner_id,attempt_id FROM conversation_manifest_index_retention WHERE index_id=?'
    )
    .get(attempt.indexId)
  if (row?.owner_id !== attempt.ownerId || row.attempt_id !== attempt.attemptId) {
    throw new Error('Retention preparation superseded')
  }
}
/** A takeover fences older workers by token, without assuming a lease clock survived a crash. */
export async function prepareConversationIndexRetention(
  db: Database.Database,
  index: ConversationManifestPartIndex,
  signal: AbortSignal
): Promise<ConversationIndexRetentionAttempt> {
  if (db.isTransaction) {
    throw new Error('Retention preparation must run outside writer transaction')
  }
  signal.throwIfAborted()
  const attempt = runJournalTransaction(db, () => {
    assertIndex(db, index)
    const existing = db
      .prepare('SELECT * FROM conversation_manifest_index_retention WHERE index_id=?')
      .get(index.indexId)
    const ownerId = `conversation-index:${index.indexId}`
    if (
      existing &&
      (existing.owner_id !== ownerId ||
        existing.root_digest !== index.rootDigest ||
        existing.part_count !== index.partCount)
    ) {
      throw new Error('Retention identity changed')
    }
    const attemptId =
      existing?.state === 'retained' && typeof existing.attempt_id === 'string'
        ? existing.attempt_id
        : randomUUID()
    db.prepare(`INSERT INTO conversation_manifest_index_retention VALUES(?,?,?,?,?,'preparing')
      ON CONFLICT(index_id) DO UPDATE SET attempt_id=excluded.attempt_id`).run(
      index.indexId,
      ownerId,
      index.rootDigest,
      index.partCount,
      attemptId
    )
    return {
      indexId: index.indexId,
      ownerId,
      attemptId,
      newOwner: !existing,
      authorityRevision: readConversationAuthorityRevision(db)
    }
  })
  try {
    let session = '',
      epoch = ''
    while (true) {
      signal.throwIfAborted()
      const page = db
        .prepare(`SELECT session_id,epoch,end_sequence FROM conversation_manifest_source_boundaries
        WHERE index_id=? AND (session_id,epoch)>(?,?) ORDER BY session_id,epoch LIMIT 128`)
        .all(index.indexId, session, epoch)
      if (page.length === 0) {
        break
      }
      runJournalTransaction(db, () => {
        assertAttempt(db, attempt)
        for (const boundary of page) {
          if (
            typeof boundary.session_id !== 'string' ||
            typeof boundary.epoch !== 'string' ||
            typeof boundary.end_sequence !== 'number'
          ) {
            throw new Error('Corrupt source boundary')
          }
          pinJournalEpoch(db, {
            ownerId: attempt.ownerId,
            sessionId: boundary.session_id,
            epoch: boundary.epoch,
            endSequence: boundary.end_sequence
          })
          session = boundary.session_id
          epoch = boundary.epoch
        }
      })
      await setImmediate()
    }
    signal.throwIfAborted()
    assertAttempt(db, attempt)
    return attempt
  } catch (error) {
    await abandonConversationIndexRetention(db, attempt)
    throw error
  }
}
export function commitConversationIndexRetention(
  db: Database.Database,
  index: ConversationManifestPartIndex,
  attempt: ConversationIndexRetentionAttempt
): void {
  if (!db.isTransaction || index.indexId !== attempt.indexId) {
    throw new Error('Retention completion requires the authority transaction')
  }
  assertIndex(db, index)
  assertAttempt(db, attempt)
  assertConversationAuthorityRevision(db, attempt.authorityRevision)
  db.prepare(
    "UPDATE conversation_manifest_index_retention SET state='retained' WHERE index_id=? AND attempt_id=?"
  ).run(attempt.indexId, attempt.attemptId)
}
/** Only the failing creator may release new pins; resumed preparation needs explicit recovery/delete. */
export async function abandonConversationIndexRetention(
  db: Database.Database,
  attempt: ConversationIndexRetentionAttempt
): Promise<void> {
  if (!attempt.newOwner) {
    return
  }
  while (true) {
    const finished = runJournalTransaction(db, () => {
      const owner = db
        .prepare(
          'SELECT attempt_id,state FROM conversation_manifest_index_retention WHERE index_id=?'
        )
        .get(attempt.indexId)
      if (owner?.attempt_id !== attempt.attemptId || owner.state !== 'preparing') {
        return true
      }
      const pins = db
        .prepare(
          'SELECT session_id,epoch,end_sequence FROM journal_epoch_pins WHERE owner_id=? ORDER BY session_id,epoch LIMIT 128'
        )
        .all(attempt.ownerId)
      if (pins.length === 0) {
        db.prepare(
          'DELETE FROM conversation_manifest_index_retention WHERE index_id=? AND attempt_id=?'
        ).run(attempt.indexId, attempt.attemptId)
        return true
      }
      for (const pin of pins) {
        if (
          typeof pin.session_id !== 'string' ||
          typeof pin.epoch !== 'string' ||
          typeof pin.end_sequence !== 'number'
        ) {
          throw new Error('Corrupt retention pin')
        }
        releaseJournalEpochPin(db, {
          ownerId: attempt.ownerId,
          sessionId: pin.session_id,
          epoch: pin.epoch,
          endSequence: pin.end_sequence
        })
      }
      return false
    })
    if (finished) {
      return
    }
    await setImmediate()
  }
}
/** Metadata only: caller must also check authority revision, which fences pin deletion/update. */
export function assertConversationIndexRetention(
  db: Database.Database,
  index: ConversationManifestPartIndex,
  ownerId: string
): void {
  const row = db
    .prepare(
      'SELECT owner_id,root_digest,part_count,state FROM conversation_manifest_index_retention WHERE index_id=?'
    )
    .get(index.indexId)
  if (
    row?.owner_id !== ownerId ||
    row.root_digest !== index.rootDigest ||
    row.part_count !== index.partCount ||
    row.state !== 'retained'
  ) {
    throw new Error('Index source retention is unverified')
  }
}
