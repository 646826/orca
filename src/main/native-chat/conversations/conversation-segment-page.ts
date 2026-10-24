import type Database from '../../sqlite/sync-database'
import {
  isConversationSegment,
  type ConversationSegment
} from '../../../shared/conversation-record'
import { ConversationRefusal } from './conversation-read-model'

export function readConversationSegmentPage(
  db: Database.Database,
  conversationId: string,
  beforeOrdinal: number | null,
  limit: number
): { segments: ConversationSegment[]; nextSegmentOrdinal: number | null } {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 128 ||
    (beforeOrdinal !== null && (!Number.isSafeInteger(beforeOrdinal) || beforeOrdinal < 1))
  ) {
    throw new RangeError('Conversation segment page')
  }
  const rows = db
    .prepare(`SELECT record_json,ordinal,segment_id FROM conversation_segments
    WHERE conversation_id=? AND NOT EXISTS (SELECT 1 FROM conversation_archive_deletions d WHERE d.conversation_id=conversation_segments.conversation_id AND d.context_generation=json_extract(conversation_segments.record_json,'$.contextGeneration')) AND ordinal<? AND COALESCE(json_extract(record_json,'$.lifecycle'),'activated')='activated'
    ORDER BY ordinal DESC LIMIT ?`)
    .all(conversationId, beforeOrdinal ?? Number.MAX_SAFE_INTEGER, limit + 1)
  const segments = rows.slice(0, limit).map((row) => {
    const segment: unknown =
      typeof row.record_json === 'string' ? JSON.parse(row.record_json) : null
    if (
      !isConversationSegment(segment) ||
      segment.conversationId !== conversationId ||
      segment.ordinal !== row.ordinal ||
      segment.segmentId !== row.segment_id
    ) {
      throw new ConversationRefusal('corrupt-record')
    }
    return segment
  })
  return { segments, nextSegmentOrdinal: rows.length > limit ? segments.at(-1)!.ordinal : null }
}
