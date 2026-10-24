import { releaseQueuedMessageEvidence } from './queued-message-evidence-retention'
import type Database from '../../sqlite/sync-database'
import { readJournalRowsAfter, type JournalStoredRow } from './journal-row-reader'

export type JournalEpochPin = {
  ownerId: string
  sessionId: string
  epoch: string
  endSequence: number
}

export function createJournalEpochPinTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS journal_epoch_pins (
  owner_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  end_sequence INTEGER NOT NULL CHECK (end_sequence > 0),
  PRIMARY KEY (owner_id, session_id, epoch)
);
CREATE INDEX IF NOT EXISTS journal_epoch_pins_source ON journal_epoch_pins (session_id, epoch);
CREATE TRIGGER IF NOT EXISTS journal_pinned_epoch_delete
BEFORE DELETE ON journal_rows
WHEN EXISTS (SELECT 1 FROM journal_epoch_pins WHERE session_id = OLD.session_id AND epoch = OLD.epoch)
BEGIN SELECT RAISE(ABORT, 'journal epoch is pinned'); END;
CREATE TRIGGER IF NOT EXISTS journal_pinned_epoch_update
BEFORE UPDATE ON journal_rows
WHEN EXISTS (SELECT 1 FROM journal_epoch_pins WHERE session_id = OLD.session_id AND epoch = OLD.epoch)
  OR EXISTS (SELECT 1 FROM journal_epoch_pins WHERE session_id = NEW.session_id AND epoch = NEW.epoch)
BEGIN SELECT RAISE(ABORT, 'journal epoch is pinned'); END;
CREATE TRIGGER IF NOT EXISTS journal_pinned_epoch_replace
BEFORE INSERT ON journal_rows
WHEN EXISTS (SELECT 1 FROM journal_epoch_pins WHERE session_id = NEW.session_id AND epoch = NEW.epoch)
  AND EXISTS (SELECT 1 FROM journal_rows WHERE session_id = NEW.session_id AND epoch = NEW.epoch AND seq = NEW.seq)
BEGIN SELECT RAISE(ABORT, 'journal epoch is pinned'); END;
`
}

function requireTransaction(db: Database.Database): void {
  if (!db.isTransaction) {
    throw new Error('journal epoch pin mutation requires a transaction')
  }
}

function storedEndSequence(db: Database.Database, pin: JournalEpochPin): unknown {
  return db
    .prepare(`SELECT end_sequence FROM journal_epoch_pins
    WHERE owner_id = ? AND session_id = ? AND epoch = ?`)
    .get(pin.ownerId, pin.sessionId, pin.epoch)?.end_sequence
}

/** Retains captured bytes; the compiler validates row contents outside the writer transaction. */
export function pinJournalEpoch(db: Database.Database, pin: JournalEpochPin): JournalEpochPin {
  requireTransaction(db)
  if (
    !pin.ownerId ||
    !pin.sessionId ||
    !pin.epoch ||
    !Number.isSafeInteger(pin.endSequence) ||
    pin.endSequence < 1
  ) {
    throw new Error('journal epoch pin requires an owner, source and positive safe end sequence')
  }
  const existing = storedEndSequence(db, pin)
  if (existing !== undefined && existing !== pin.endSequence) {
    throw new Error('journal epoch pin conflicts with its frozen source')
  }
  if (existing === undefined) {
    const prefix = db
      .prepare(`SELECT count(*) AS total, min(seq) AS first, max(seq) AS last
      FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq >= 1 AND seq <= ?`)
      .get(pin.sessionId, pin.epoch, pin.endSequence)
    if (
      prefix?.total !== pin.endSequence ||
      prefix.first !== 1 ||
      prefix.last !== pin.endSequence
    ) {
      throw new Error('journal epoch pin source prefix is unavailable or not contiguous')
    }
    db.prepare(`INSERT INTO journal_epoch_pins (owner_id, session_id, epoch, end_sequence)
      VALUES (?, ?, ?, ?)`).run(pin.ownerId, pin.sessionId, pin.epoch, pin.endSequence)
  }
  return { ...pin }
}

function* iterateFrozenPrefix(
  db: Database.Database,
  pin: JournalEpochPin
): Generator<JournalStoredRow> {
  let sequence = 0
  while (sequence < pin.endSequence) {
    const page = readJournalRowsAfter(
      db,
      pin.sessionId,
      pin.epoch,
      sequence,
      Math.min(128, pin.endSequence - sequence)
    )
    if (page.length === 0) {
      throw new Error('journal epoch pin source prefix is unavailable')
    }
    for (const row of page) {
      if (row.seq !== sequence + 1 || row.seq > pin.endSequence) {
        throw new Error('journal epoch pin source prefix is not contiguous')
      }
      yield row
      sequence = row.seq
    }
  }
}

export function* iteratePinnedJournalEpochRows(
  db: Database.Database,
  pin: JournalEpochPin
): Generator<JournalStoredRow> {
  if (storedEndSequence(db, pin) !== pin.endSequence) {
    throw new Error('journal epoch pin is missing or changed')
  }
  yield* iterateFrozenPrefix(db, pin)
}

export function releaseJournalEpochPin(
  db: Database.Database,
  pin: JournalEpochPin,
  options: { deferRowPrune?: boolean } = {}
): void {
  requireTransaction(db)
  const end = storedEndSequence(db, pin)
  if (end === undefined) {
    return
  }
  if (end !== pin.endSequence) {
    throw new Error('journal epoch pin conflicts with its frozen source')
  }
  db.prepare(
    'DELETE FROM journal_epoch_pins WHERE owner_id=? AND session_id=? AND epoch=? AND end_sequence=?'
  ).run(pin.ownerId, pin.sessionId, pin.epoch, pin.endSequence)
  if (options.deferRowPrune) {
    return
  }
  db.prepare(`DELETE FROM journal_rows WHERE session_id = ? AND epoch = ?
    AND NOT EXISTS (SELECT 1 FROM journal_epoch_pins WHERE session_id = ? AND epoch = ?)
    AND NOT EXISTS (SELECT 1 FROM journal_sessions WHERE session_id = ? AND epoch = ?)`).run(
    pin.sessionId,
    pin.epoch,
    pin.sessionId,
    pin.epoch,
    pin.sessionId,
    pin.epoch
  )
}

export function releaseJournalEpochPins(db: Database.Database, ownerId: string): void {
  requireTransaction(db)
  releaseQueuedMessageEvidence(db, ownerId)
  const sources = db
    .prepare('SELECT session_id,epoch,end_sequence FROM journal_epoch_pins WHERE owner_id=?')
    .all(ownerId)
  for (const source of sources) {
    if (
      typeof source.session_id !== 'string' ||
      typeof source.epoch !== 'string' ||
      typeof source.end_sequence !== 'number'
    ) {
      throw new Error('journal epoch pin source is unreadable')
    }
    releaseJournalEpochPin(db, {
      ownerId,
      sessionId: source.session_id,
      epoch: source.epoch,
      endSequence: source.end_sequence
    })
  }
}
