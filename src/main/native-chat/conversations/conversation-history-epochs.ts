import type Database from '../../sqlite/sync-database'
import type { ConversationSegment } from '../../../shared/conversation-record'
import { parseJournalRow, type JournalEpochRow } from '../agent-session-journal/journal-row-schema'
import { sameJournalConversation } from '../agent-session-journal/journal-history-origin'
import { readJournalSessionEpoch } from '../agent-session-journal/journal-row-table'
import { readParticipant } from './conversation-read-model'
export type ConversationHistoryEpoch = { epoch: string; endSequence: number; head: JournalEpochRow }
/** Epoch order is host append order, independent of client clocks and reused per-epoch sequences. */
export function conversationHistoryEpochs(
  db: Database.Database,
  segment: ConversationSegment
): ConversationHistoryEpoch[] | null {
  const rows = db
    .prepare(`SELECT spans.epoch,MAX(spans.end_sequence) tip,r.row_json FROM conversation_source_spans spans
 JOIN conversation_segments s ON s.segment_id=spans.segment_id
 LEFT JOIN journal_rows r ON r.session_id=spans.session_id AND r.epoch=spans.epoch AND r.seq=1
 WHERE spans.session_id=? AND s.conversation_id=? AND json_extract(s.record_json,'$.contextGeneration')=? AND json_extract(s.record_json,'$.nativeBindingGeneration')=?
 GROUP BY spans.epoch ORDER BY r.rowid`)
    .all(
      segment.sessionId,
      segment.conversationId,
      segment.contextGeneration,
      segment.nativeBindingGeneration
    )
  const result: ConversationHistoryEpoch[] = []
  for (const row of rows) {
    if (typeof row.epoch !== 'string' || typeof row.tip !== 'number') {
      throw new Error('Historical epoch corrupt')
    }
    if (typeof row.row_json !== 'string') {
      return null
    }
    const parsed = parseJournalRow(row.row_json)
    if (!parsed.ok || parsed.row.kind !== 'epoch') {
      return null
    }
    const previous = result.at(-1)
    if (
      previous &&
      (!sameJournalConversation(previous.head.providerHandle, parsed.row.providerHandle) ||
        parsed.row.replacementOf?.epoch !== previous.epoch ||
        parsed.row.replacementOf.endSequence !== previous.endSequence)
    ) {
      return null
    }
    result.push({ epoch: row.epoch, endSequence: row.tip, head: parsed.row })
  }
  const participant = readParticipant(db, segment.sessionId)
  // An old generation is an archive. The current native binding must include its
  // current epoch; otherwise missing attribution could masquerade as complete history.
  if (
    participant?.contextGeneration === segment.contextGeneration &&
    participant.nativeBindingGeneration === segment.nativeBindingGeneration &&
    readJournalSessionEpoch(db, segment.sessionId) !== result.at(-1)?.epoch
  ) {
    return null
  }
  return result
}
