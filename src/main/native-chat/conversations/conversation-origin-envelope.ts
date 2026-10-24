import type Database from '../../sqlite/sync-database'
import { parseConversationOrigin, parseConversationOriginKeys } from './conversation-origin'
import { attributeConversationSourceBoundary } from './conversation-source-attribution'

/** Only a structural settlement envelope may inherit unanimous, independently captured atoms. */
export function resolveConversationOriginEnvelope(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  sequence: number
): boolean {
  if (!db.isTransaction) {
    throw new Error('origin envelope requires transaction')
  }
  const expected = db
    .prepare(
      'SELECT mutation_count FROM conversation_origin_batch_envelopes WHERE session_id=? AND epoch=? AND sequence=?'
    )
    .get(sessionId, epoch, sequence)?.mutation_count
  if (
    typeof expected !== 'number' ||
    !Number.isSafeInteger(expected) ||
    expected < 1 ||
    expected > 200
  ) {
    return false
  }
  const rows = db
    .prepare(`SELECT atom_path,keys_json,origin_json,conversation_id,context_generation,native_binding_generation
    FROM conversation_origin_rows WHERE session_id=? AND epoch=? AND sequence=? ORDER BY atom_path LIMIT 202`)
    .all(sessionId, epoch, sequence)
  const envelope = rows[0]
  if (
    !envelope ||
    envelope.atom_path !== '$' ||
    envelope.origin_json !== null ||
    rows.length !== expected + 1
  ) {
    return false
  }
  const keys = parseConversationOriginKeys(JSON.parse(String(envelope.keys_json)))
  if (keys.length !== 1 || keys[0]?.kind !== 'event' || !keys[0].id.startsWith('settlement:')) {
    return false
  }
  const atoms = rows.slice(1)
  const paths = new Set(atoms.map((row) => row.atom_path))
  const first = atoms[0]?.origin_json
  if (
    typeof first !== 'string' ||
    atoms.some((row, index) => !paths.has(`$.mutations[${index}]`) || row.origin_json !== first)
  ) {
    return false
  }
  const origin = parseConversationOrigin(JSON.parse(first))
  if (
    origin.conversationId !== envelope.conversation_id ||
    origin.contextGeneration !== envelope.context_generation ||
    origin.nativeBindingGeneration !== envelope.native_binding_generation
  ) {
    return false
  }
  db.prepare(
    "UPDATE conversation_origin_rows SET origin_json=? WHERE session_id=? AND epoch=? AND sequence=? AND atom_path='$' AND origin_json IS NULL"
  ).run(first, sessionId, epoch, sequence)
  attributeConversationSourceBoundary(db, origin.segmentId, sessionId, origin.contextGeneration, {
    sessionId,
    epoch,
    endSequence: sequence
  })
  return true
}
