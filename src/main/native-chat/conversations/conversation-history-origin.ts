import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { readConversationSourceSegmentId } from './conversation-source-attribution'
import { parseConversationOrigin, assertConversationOrigin } from './conversation-origin'
export function conversationHistoricalItemSegment(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  item: AgentJournalRenderItem
): string | null {
  const source = { sessionId, epoch, sequence: item.sequence }
  const version = db
    .prepare(
      'SELECT row_kind,sha256,mutation_count FROM conversation_source_versions WHERE session_id=? AND epoch=? AND sequence=?'
    )
    .get(sessionId, epoch, item.sequence)
  const kind = version?.row_kind
  const path = kind === 'lifecycle-batch' ? `$.mutations[${item.sequenceIndex ?? 0}]` : '$'
  const row = db
    .prepare(
      'SELECT origin_json FROM conversation_origin_rows WHERE session_id=? AND epoch=? AND sequence=? AND atom_path=?'
    )
    .get(sessionId, epoch, item.sequence, path)
  if (row) {
    if (typeof row.origin_json !== 'string') {
      return null
    }
    const origin = parseConversationOrigin(JSON.parse(row.origin_json))
    assertConversationOrigin(db, sessionId, origin)
    return origin.segmentId
  }
  if (kind === 'lifecycle-batch') {
    const atom = db
      .prepare(
        'SELECT segment_id,context_generation,native_binding_generation,row_sha256,mutation_count FROM conversation_source_atoms WHERE session_id=? AND epoch=? AND sequence=? AND atom_path=?'
      )
      .get(sessionId, epoch, item.sequence, path)
    if (
      typeof atom?.segment_id !== 'string' ||
      atom.row_sha256 !== version?.sha256 ||
      atom.mutation_count !== version?.mutation_count
    ) {
      return null
    }
    const segment = db
      .prepare('SELECT conversation_id FROM conversation_segments WHERE segment_id=?')
      .get(atom.segment_id)
    if (
      typeof segment?.conversation_id !== 'string' ||
      typeof atom.context_generation !== 'number' ||
      typeof atom.native_binding_generation !== 'number'
    ) {
      return null
    }
    assertConversationOrigin(db, sessionId, {
      conversationId: segment.conversation_id,
      segmentId: atom.segment_id,
      contextGeneration: atom.context_generation,
      nativeBindingGeneration: atom.native_binding_generation
    })
    return atom.segment_id
  }
  return readConversationSourceSegmentId(db, source)
}
