import type Database from '../../sqlite/sync-database'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import { assertConversationOrigin, parseConversationOrigin } from './conversation-origin'
import { readConversationClearIntent } from './conversation-pending-mutation'

/** Receipt-authored control facts retain the pre-clear segment, never the new prompt generation. */
export function readConversationClearRowOrigin(
  db: Database.Database,
  sessionId: string,
  row: JournalRow
) {
  const saved = db
    .prepare(
      'SELECT operation_key,origin_json FROM conversation_clear_rows WHERE session_id=? AND epoch=? AND sequence=?'
    )
    .get(sessionId, row.epoch, row.seq)
  if (!saved) {
    return null
  }
  if (typeof saved.operation_key !== 'string' || typeof saved.origin_json !== 'string') {
    throw new Error('Invalid clear origin')
  }
  const intent = readConversationClearIntent(db, saved.operation_key)
  const origin = parseConversationOrigin(JSON.parse(saved.origin_json))
  if (
    !intent ||
    intent.phase !== 'committed' ||
    intent.conversationId !== origin.conversationId ||
    intent.contextGeneration !== origin.contextGeneration
  ) {
    throw new Error('Invalid clear origin')
  }
  assertConversationOrigin(db, sessionId, origin)
  return origin
}
