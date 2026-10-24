import type Database from '../../sqlite/sync-database'
import type { ConversationManifestPartIndex } from './conversation-context-parts'

/** Host preview query: counts derive from the immutable sealed parts, never inline-only gaps. */
export function readConversationManifestIndexSummary(
  db: Database.Database,
  index: ConversationManifestPartIndex
): {
  index: ConversationManifestPartIndex
  representations: Record<
    'exact' | 'transport-projected' | 'summarized' | 'retrievable-only' | 'missing',
    number
  >
  gapCount: number
} {
  const stored = db
    .prepare(
      'SELECT root_digest,part_count FROM conversation_manifest_part_indexes WHERE index_id=?'
    )
    .get(index.indexId)
  if (stored?.root_digest !== index.rootDigest || stored.part_count !== index.partCount) {
    throw new Error('Context index is unverified')
  }
  const representations = {
    exact: 0,
    'transport-projected': 0,
    summarized: 0,
    'retrievable-only': 0,
    missing: 0
  }
  const rows = db
    .prepare(
      "SELECT json_extract(part_json,'$.part.representation') representation,COUNT(*) count, SUM(json_array_length(part_json,'$.gaps')) gaps FROM conversation_manifest_parts WHERE index_id=? GROUP BY json_extract(part_json,'$.part.representation')"
    )
    .all(index.indexId)
  let gapCount = 0,
    total = 0
  for (const row of rows) {
    if (
      (row.representation !== 'exact' &&
        row.representation !== 'transport-projected' &&
        row.representation !== 'summarized' &&
        row.representation !== 'retrievable-only' &&
        row.representation !== 'missing') ||
      typeof row.count !== 'number' ||
      typeof row.gaps !== 'number'
    ) {
      throw new Error('Corrupt context index summary')
    }
    representations[row.representation] = row.count
    gapCount += row.gaps
    total += row.count
  }
  if (total !== index.partCount) {
    throw new Error('Incomplete context index summary')
  }
  return { index, representations, gapCount }
}
