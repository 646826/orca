import { readConversationPendingMutation } from './conversation-pending-mutation'
import type Database from '../../sqlite/sync-database'
import {
  isConversationRecord,
  isConversationParticipant,
  isConversationSegment,
  isConversationSwitchIntent,
  type ConversationRecord,
  type ConversationParticipant,
  type ConversationSegment,
  type ConversationSwitchIntent,
  type ConversationSourceBoundary
} from '../../../shared/conversation-record'
import type {
  ConversationRefusalReason,
  ConversationSessionRoute
} from '../../../shared/conversation-wire'
import { readJournalSessionEpoch } from '../agent-session-journal/journal-row-table'

export class ConversationRefusal extends Error {
  constructor(readonly reason: ConversationRefusalReason) {
    super(reason)
  }
}
function decode<T>(
  row: { record_json?: unknown } | undefined,
  valid: (value: unknown) => value is T
): T | null {
  if (!row) {
    return null
  }
  if (typeof row.record_json !== 'string') {
    throw new ConversationRefusal('corrupt-record')
  }
  let value: unknown
  try {
    value = JSON.parse(row.record_json)
  } catch {
    throw new ConversationRefusal('corrupt-record')
  }
  if (!valid(value)) {
    throw new ConversationRefusal('corrupt-record')
  }
  return value
}
export function readConversation(db: Database.Database, id: string): ConversationRecord | null {
  return decode(
    db.prepare('SELECT record_json FROM conversations WHERE conversation_id = ?').get(id),
    isConversationRecord
  )
}
export function readParticipant(db: Database.Database, id: string): ConversationParticipant | null {
  return decode(
    db.prepare('SELECT record_json FROM conversation_participants WHERE session_id = ?').get(id),
    isConversationParticipant
  )
}
export function readSwitchIntent(
  db: Database.Database,
  key: string
): ConversationSwitchIntent | null {
  return decode(
    db
      .prepare('SELECT record_json FROM conversation_switch_intents WHERE operation_key = ?')
      .get(key),
    isConversationSwitchIntent
  )
}
export function readConversationSegment(
  db: Database.Database,
  conversationId: string,
  segmentId: string
): ConversationSegment | null {
  return decode(
    db
      .prepare(
        'SELECT record_json FROM conversation_segments WHERE conversation_id=? AND segment_id=?'
      )
      .get(conversationId, segmentId),
    isConversationSegment
  )
}
export function readSegments(db: Database.Database, id: string): ConversationSegment[] {
  return db
    .prepare(
      'SELECT record_json FROM conversation_segments WHERE conversation_id = ? ORDER BY ordinal'
    )
    .all(id)
    .map((row) => {
      const segment = decode(row, isConversationSegment)
      if (!segment) {
        throw new ConversationRefusal('corrupt-record')
      }
      return segment
    })
}
export function readSourceBoundary(
  db: Database.Database,
  sessionId: string
): ConversationSourceBoundary {
  const epoch = readJournalSessionEpoch(db, sessionId)
  if (!epoch) {
    throw new ConversationRefusal('missing-source')
  }
  const row = db
    .prepare('SELECT MAX(seq) AS tip FROM journal_rows WHERE session_id = ? AND epoch = ?')
    .get(sessionId, epoch)
  if (typeof row?.tip !== 'number' || !Number.isSafeInteger(row.tip) || row.tip < 1) {
    throw new ConversationRefusal('missing-source')
  }
  return { sessionId, epoch, endSequence: row.tip }
}

export function readConversationDeliverySources(
  db: Database.Database,
  conversationId: string,
  candidateSessionId: string
): ConversationSourceBoundary[] {
  return db
    .prepare(`SELECT r.session_id, r.epoch, MAX(r.seq) AS tip FROM journal_rows r
    JOIN conversation_participants p ON p.session_id=r.session_id
    JOIN conversations c ON c.conversation_id=p.conversation_id
    WHERE COALESCE(json_extract(r.row_json,'$.kind'),'')<>'queue' AND json_extract(p.record_json,'$.contextGeneration')=json_extract(c.record_json,'$.contextGeneration') AND p.conversation_id=? AND r.session_id<>? AND (
      EXISTS(SELECT 1 FROM conversation_segments s WHERE s.conversation_id=p.conversation_id AND json_extract(s.record_json,'$.sessionId')=r.session_id AND json_extract(s.record_json,'$.contextGeneration')=json_extract(c.record_json,'$.contextGeneration') AND COALESCE(json_extract(s.record_json,'$.lifecycle'),'activated')='activated')
      OR EXISTS(SELECT 1 FROM conversation_source_attribution a JOIN conversation_segments s ON s.segment_id=a.segment_id WHERE a.session_id=r.session_id AND s.conversation_id=p.conversation_id AND json_extract(s.record_json,'$.contextGeneration')=json_extract(c.record_json,'$.contextGeneration'))
    ) AND (
      EXISTS(SELECT 1 FROM journal_epoch_pins pin WHERE pin.session_id=r.session_id AND pin.epoch=r.epoch)
      OR EXISTS(SELECT 1 FROM journal_sessions live WHERE live.session_id=r.session_id AND live.epoch=r.epoch))
    GROUP BY r.session_id,r.epoch ORDER BY r.session_id,r.epoch`)
    .all(conversationId, candidateSessionId)
    .map((row) => {
      if (
        typeof row.session_id !== 'string' ||
        typeof row.epoch !== 'string' ||
        typeof row.tip !== 'number'
      ) {
        throw new ConversationRefusal('corrupt-record')
      }
      return { sessionId: row.session_id, epoch: row.epoch, endSequence: row.tip }
    })
}
export function readParticipantSourceBoundaries(
  db: Database.Database,
  sessionId: string
): ConversationSourceBoundary[] {
  return db
    .prepare(
      `SELECT epoch,MAX(seq) AS tip FROM journal_rows WHERE session_id=? AND COALESCE(json_extract(row_json,'$.kind'),'')<>'queue' GROUP BY epoch ORDER BY epoch`
    )
    .all(sessionId)
    .map((row) => {
      if (typeof row.epoch !== 'string' || typeof row.tip !== 'number') {
        throw new ConversationRefusal('corrupt-record')
      }
      return { sessionId, epoch: row.epoch, endSequence: row.tip }
    })
}

export type ConversationTimelineCursor = {
  segmentOrdinal: number
  epochOrdinal: number
  sequence: number
}
export type ConversationTimelineReference = {
  segmentId: string
  cursor: ConversationTimelineCursor
  source: { sessionId: string; epoch: string; sequence: number }
}
export function readConversationTimelinePage(
  db: Database.Database,
  conversationId: string,
  after: ConversationTimelineCursor | null,
  limit: number
): ConversationTimelineReference[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
    throw new RangeError('timeline page size must be 1..256')
  }
  return db
    .prepare(`SELECT seg.segment_id,seg.ordinal AS segment_ordinal,span.ordinal AS epoch_ordinal,r.session_id,r.epoch,r.seq
    FROM conversation_segments seg JOIN conversation_source_spans span ON span.segment_id=seg.segment_id
    JOIN journal_rows r ON r.session_id=span.session_id AND r.epoch=span.epoch AND r.seq BETWEEN span.start_sequence AND span.end_sequence
    LEFT JOIN conversation_source_attribution explicit ON explicit.session_id=r.session_id AND explicit.epoch=r.epoch AND explicit.sequence=r.seq
    WHERE seg.conversation_id=? AND NOT EXISTS (SELECT 1 FROM conversation_archive_deletions d WHERE d.conversation_id=seg.conversation_id AND d.context_generation=json_extract(seg.record_json,'$.contextGeneration')) AND (explicit.segment_id=seg.segment_id OR (explicit.segment_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM conversation_source_spans earlier JOIN conversation_segments old ON old.segment_id=earlier.segment_id
      WHERE old.conversation_id=seg.conversation_id AND old.ordinal<seg.ordinal AND earlier.session_id=r.session_id AND earlier.epoch=r.epoch AND r.seq BETWEEN earlier.start_sequence AND earlier.end_sequence)))
    AND (seg.ordinal,span.ordinal,r.seq) > (?,?,?) ORDER BY seg.ordinal,span.ordinal,r.seq LIMIT ?`)
    .all(
      conversationId,
      after?.segmentOrdinal ?? 0,
      after?.epochOrdinal ?? 0,
      after?.sequence ?? 0,
      limit
    )
    .map((row) => {
      if (
        typeof row.segment_id !== 'string' ||
        typeof row.segment_ordinal !== 'number' ||
        typeof row.epoch_ordinal !== 'number' ||
        typeof row.session_id !== 'string' ||
        typeof row.epoch !== 'string' ||
        typeof row.seq !== 'number'
      ) {
        throw new ConversationRefusal('corrupt-record')
      }
      return {
        segmentId: row.segment_id,
        cursor: {
          segmentOrdinal: row.segment_ordinal,
          epochOrdinal: row.epoch_ordinal,
          sequence: row.seq
        },
        source: { sessionId: row.session_id, epoch: row.epoch, sequence: row.seq }
      }
    })
}

export function readConversationSessionRoute(
  db: Database.Database,
  sessionId: string
): ConversationSessionRoute {
  const member = readParticipant(db, sessionId)
  if (!member) {
    return { role: 'unbound' }
  }
  const conversation = readConversation(db, member.conversationId)
  if (!conversation) {
    throw new ConversationRefusal('corrupt-record')
  }
  const pending = readConversationPendingMutation(db, conversation)
  const intent = pending?.kind === 'switch' ? pending.intent : null
  return {
    role:
      member.state === 'active'
        ? 'active'
        : intent?.targetSessionId === sessionId
          ? 'candidate'
          : 'parked',
    conversationId: conversation.conversationId,
    contextGeneration: conversation.contextGeneration,
    activationFence: conversation.activationFence,
    nativeBindingGeneration: member.nativeBindingGeneration,
    mutation: pending?.kind ?? 'none',
    switching: intent !== null
  }
}
