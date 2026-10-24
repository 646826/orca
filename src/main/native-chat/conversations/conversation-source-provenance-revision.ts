import type Database from '../../sqlite/sync-database'

/** Source-only freshness. Export proofs/claims and candidate-only writes must not invalidate it. */
export function createConversationSourceProvenanceRevisionTablesSql(): string {
  const direct = [
    'conversation_origin_rows',
    'conversation_pending_native_identity',
    'conversation_origin_batch_envelopes',
    'conversation_origin_bindings',
    'conversation_origin_acquisitions',
    'conversation_origin_enrollments',
    'conversation_origin_correlations',
    'conversation_source_attribution',
    'conversation_participants',
    'journal_rows'
  ]
  const increment = (
    expression: string
  ) => `INSERT INTO conversation_source_provenance_revisions(session_id,revision)
    SELECT ${expression},1 WHERE ${expression} IS NOT NULL
    ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;`
  const triggers = (table: string, events: readonly string[], column: (side: string) => string) =>
    events
      .map((event) => {
        const sides = event === 'INSERT' ? ['NEW'] : event === 'DELETE' ? ['OLD'] : ['OLD', 'NEW']
        const changed = (side: string) =>
          table === 'journal_rows'
            ? `CASE WHEN (CASE WHEN json_valid(${side}.row_json) THEN json_extract(${side}.row_json,'$.kind') END)='queue' THEN NULL ELSE ${column(side)} END`
            : table === 'conversation_origin_rows'
              ? `CASE WHEN json_extract(${side}.keys_json,'$[0].kind')='event' AND json_extract(${side}.keys_json,'$[0].id') LIKE 'queue:%' THEN NULL ELSE ${column(side)} END`
              : column(side)
        const name = `${table}_source_provenance_${event.toLowerCase()}`
        return `${table === 'journal_rows' || table === 'conversation_origin_rows' ? `DROP TRIGGER IF EXISTS ${name};` : ''}
        CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${event} ON ${table}
      BEGIN ${sides.map((side) => increment(changed(side))).join('\n')} END;`
      })
      .join('\n')
  return `CREATE TABLE IF NOT EXISTS conversation_source_provenance_revisions(session_id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO conversation_source_provenance_revisions SELECT session_id,0 FROM conversation_participants;
    ${direct.map((table) => triggers(table, ['INSERT', 'UPDATE', 'DELETE'], (side) => `${side}.session_id`)).join('\n')}
    ${triggers('conversation_segments', ['INSERT', 'UPDATE', 'DELETE'], (side) => `json_extract(${side}.record_json,'$.sessionId')`)}
    -- Initial atom inserts are derived proofs: a snapshot already requires complete origins or frozen enrollment.
    ${triggers('conversation_source_atoms', ['UPDATE', 'DELETE'], (side) => `${side}.session_id`)}`
}
export type ConversationSourceProvenance = { sessionId: string; revision: number }[]
export function readConversationSourceProvenance(
  db: Database.Database,
  conversationId: string,
  targetSessionId: string
): ConversationSourceProvenance {
  return db
    .prepare(`SELECT p.session_id,COALESCE(r.revision,0) revision FROM conversation_participants p
 LEFT JOIN conversation_source_provenance_revisions r ON r.session_id=p.session_id
 WHERE p.conversation_id=? AND p.session_id<>? ORDER BY p.session_id`)
    .all(conversationId, targetSessionId)
    .map((row) => {
      if (
        typeof row.session_id !== 'string' ||
        typeof row.revision !== 'number' ||
        !Number.isSafeInteger(row.revision) ||
        row.revision < 0
      ) {
        throw new Error('Invalid source provenance revision')
      }
      return { sessionId: row.session_id, revision: row.revision }
    })
}

export function readConversationSessionProvenance(
  db: Database.Database,
  conversationId: string,
  sessionId: string
): { sessionId: string; revision: number } | null {
  const row = db
    .prepare(`SELECT p.session_id,COALESCE(r.revision,0) revision FROM conversation_participants p
    LEFT JOIN conversation_source_provenance_revisions r ON r.session_id=p.session_id
    WHERE p.conversation_id=? AND p.session_id=?`)
    .get(conversationId, sessionId)
  if (!row) {
    return null
  }
  if (
    typeof row.session_id !== 'string' ||
    typeof row.revision !== 'number' ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0
  ) {
    throw new Error('Invalid source provenance revision')
  }
  return { sessionId: row.session_id, revision: row.revision }
}
