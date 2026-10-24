import { readConversationEnrollmentOrigin } from './conversation-origin-capture'
import type Database from '../../sqlite/sync-database'
import type {
  ConversationSegment,
  ConversationSourceBoundary,
  ConversationSourceSpan
} from '../../../shared/conversation-record'
import type { JournalOperationReceipt } from '../agent-session-journal/journal-row-writer'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import { pinJournalEpoch } from '../agent-session-journal/journal-epoch-pins'
import { ConversationRefusal, readParticipant, readSegments } from './conversation-read-model'

export function registerConversationSourceSpan(
  db: Database.Database,
  segment: ConversationSegment,
  boundary: ConversationSourceBoundary,
  startSequence: number
): void {
  if (boundary.sessionId !== segment.sessionId) {
    throw new ConversationRefusal('identity-mismatch')
  }
  const existing = db
    .prepare('SELECT ordinal FROM conversation_source_spans WHERE segment_id = ? AND epoch = ?')
    .get(segment.segmentId, boundary.epoch)
  const next = db
    .prepare(
      'SELECT COALESCE(MAX(ordinal),0) + 1 AS ordinal FROM conversation_source_spans WHERE segment_id = ?'
    )
    .get(segment.segmentId)
  const ordinal = existing?.ordinal ?? next?.ordinal
  if (typeof ordinal !== 'number') {
    throw new ConversationRefusal('corrupt-record')
  }
  db.prepare(`INSERT INTO conversation_source_spans(segment_id,session_id,epoch,ordinal,start_sequence,end_sequence) VALUES(?,?,?,?,?,?)
    ON CONFLICT(segment_id,epoch) DO UPDATE SET start_sequence=MIN(start_sequence,excluded.start_sequence), end_sequence=MAX(end_sequence,excluded.end_sequence)`).run(
    segment.segmentId,
    segment.sessionId,
    boundary.epoch,
    ordinal,
    startSequence,
    boundary.endSequence
  )
}

/** Retention envelopes only; exact per-row attribution overrides overlapping activation spans. */
export function readConversationSourceSpans(
  db: Database.Database,
  segmentId: string
): ConversationSourceSpan[] {
  return db
    .prepare(
      'SELECT session_id,epoch,ordinal,start_sequence,end_sequence FROM conversation_source_spans WHERE segment_id = ? ORDER BY ordinal'
    )
    .all(segmentId)
    .map((row) => {
      if (
        typeof row.session_id !== 'string' ||
        typeof row.epoch !== 'string' ||
        typeof row.ordinal !== 'number' ||
        typeof row.start_sequence !== 'number' ||
        typeof row.end_sequence !== 'number'
      ) {
        throw new ConversationRefusal('corrupt-record')
      }
      return {
        segmentId,
        sessionId: row.session_id,
        epoch: row.epoch,
        ordinal: row.ordinal,
        startSequence: row.start_sequence,
        endSequence: row.end_sequence
      }
    })
}

export function conversationSourceAttributionReceipt(
  segmentId: string,
  sessionId: string,
  contextGeneration: number
): JournalOperationReceipt {
  return {
    write: (db, row) => {
      if (!row) {
        throw new ConversationRefusal('missing-source')
      }
      attributeConversationSourceBoundary(db, segmentId, sessionId, contextGeneration, {
        sessionId,
        epoch: row.epoch,
        endSequence: row.seq
      })
    },
    committed: () => {}
  }
}

export function attributeConversationSourceBoundary(
  db: Database.Database,
  segmentId: string,
  sessionId: string,
  contextGeneration: number,
  boundary: ConversationSourceBoundary
): void {
  if (!db.isTransaction) {
    throw new ConversationRefusal('missing-source')
  }
  if (boundary.sessionId !== sessionId) {
    throw new ConversationRefusal('identity-mismatch')
  }
  const record = db
    .prepare('SELECT conversation_id FROM conversation_segments WHERE segment_id = ?')
    .get(segmentId)
  if (typeof record?.conversation_id !== 'string') {
    throw new ConversationRefusal('missing-record')
  }
  const segment = readSegments(db, record.conversation_id).find((s) => s.segmentId === segmentId)
  if (!segment) {
    throw new ConversationRefusal('missing-record')
  }
  if (segment.sessionId !== sessionId || segment.contextGeneration !== contextGeneration) {
    throw new ConversationRefusal('identity-mismatch')
  }
  const source = db
    .prepare('SELECT seq FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?')
    .get(segment.sessionId, boundary.epoch, boundary.endSequence)
  if (!source) {
    throw new ConversationRefusal('missing-source')
  }
  const prior = db
    .prepare(
      'SELECT segment_id FROM conversation_source_attribution WHERE session_id = ? AND epoch = ? AND sequence = ?'
    )
    .get(segment.sessionId, boundary.epoch, boundary.endSequence)
  if (prior && prior.segment_id !== segmentId) {
    throw new ConversationRefusal('identity-mismatch')
  }
  db.prepare(
    'INSERT OR IGNORE INTO conversation_source_attribution(session_id,epoch,sequence,segment_id) VALUES(?,?,?,?)'
  ).run(segment.sessionId, boundary.epoch, boundary.endSequence, segmentId)
  registerConversationSourceSpan(
    db,
    segment,
    { sessionId: segment.sessionId, epoch: boundary.epoch, endSequence: boundary.endSequence },
    boundary.endSequence
  )
  // A prefix pin retains the whole epoch; each delivery manifest freezes its own later end.
  const pin = db
    .prepare('SELECT 1 FROM journal_epoch_pins WHERE owner_id = ? AND session_id = ? AND epoch = ?')
    .get(`conversation-source:${segmentId}`, segment.sessionId, boundary.epoch)
  if (!pin) {
    pinJournalEpoch(db, {
      ownerId: `conversation-source:${segmentId}`,
      sessionId: segment.sessionId,
      epoch: boundary.epoch,
      endSequence: boundary.endSequence
    })
  }
}

/** Checked before INSERT, applied after INSERT, so a failed retention write rolls back that row. */
export function prepareConversationEpochRetention(
  db: Database.Database,
  sessionId: string,
  row: JournalRow
): (() => void) | null {
  if (
    row.seq !== 1 ||
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_participants'"
      )
      .get()
  ) {
    return null
  }
  const member = readParticipant(db, sessionId)
  if (!member) {
    return null
  }
  if (!db.isTransaction) {
    throw new ConversationRefusal('missing-source')
  }
  return () =>
    pinJournalEpoch(db, {
      ownerId: `conversation-participant:${member.conversationId}:${sessionId}`,
      sessionId,
      epoch: row.epoch,
      endSequence: 1
    })
}

/** Explicit late attribution wins; only frozen singleton history has an interval fallback. */
export function readConversationSourceSegmentId(
  db: Database.Database,
  source: {
    sessionId: string
    epoch: string
    sequence: number
  }
): string | null {
  const explicit = db
    .prepare(
      'SELECT segment_id FROM conversation_source_attribution WHERE session_id=? AND epoch=? AND sequence=?'
    )
    .get(source.sessionId, source.epoch, source.sequence)
  if (typeof explicit?.segment_id === 'string') {
    return explicit.segment_id
  }
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_origin_enrollments'"
      )
      .get()
  ) {
    return null
  }
  return readConversationEnrollmentOrigin(db, source)?.segmentId ?? null
}
