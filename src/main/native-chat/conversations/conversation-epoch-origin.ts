import type Database from '../../sqlite/sync-database'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import type { JournalRowRestatement } from '../agent-session-journal/journal-row-writer'
import {
  assertConversationOrigin,
  parseConversationOrigin,
  type ConversationOrigin
} from './conversation-origin'
import { readConversationEnrollmentOrigin } from './conversation-origin-capture'

/** Only host-captured previous reducer coordinates or exact acquisition provenance. No active
 * participant lookup: restated old-generation facts remain old-generation archive evidence. */
export function readConversationEpochOrigin(
  db: Database.Database,
  sessionId: string,
  row: JournalRow,
  restatement?: JournalRowRestatement
): ConversationOrigin | null {
  if (restatement) {
    const source = { sessionId, ...restatement.previousSource }
    const path = source.batchIndex === undefined ? '$' : `$.mutations[${source.batchIndex}]`
    const saved = db
      .prepare(
        'SELECT origin_json FROM conversation_origin_rows WHERE session_id=? AND epoch=? AND sequence=? AND atom_path=?'
      )
      .get(sessionId, source.epoch, source.sequence, path)
    if (saved) {
      if (typeof saved.origin_json !== 'string') {
        return null
      }
      const origin = parseConversationOrigin(JSON.parse(saved.origin_json))
      assertConversationOrigin(db, sessionId, origin)
      return origin
    }
    return readConversationEnrollmentOrigin(db, source)
  }
  if (row.kind !== 'epoch') {
    return null
  }
  const captured = db
    .prepare(
      'SELECT origin_json FROM conversation_origin_acquisitions WHERE session_id=? AND fence=?'
    )
    .get(sessionId, row.fence)
  if (typeof captured?.origin_json !== 'string') {
    return null
  }
  const origin = parseConversationOrigin(JSON.parse(captured.origin_json))
  assertConversationOrigin(db, sessionId, origin)
  return origin
}
