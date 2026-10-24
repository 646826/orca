export function createConversationOriginTablesSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS conversation_pending_native_identity (
      session_id TEXT NOT NULL, fence INTEGER NOT NULL, operation_key TEXT NOT NULL,
      origin_json TEXT NOT NULL, acquisition_generation TEXT NOT NULL, process_digest TEXT NOT NULL,
      scope_digest TEXT NOT NULL, initial_chain_json TEXT NOT NULL,
      native_identity TEXT, link_json TEXT, effect_seen INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(session_id,fence)
    );
    CREATE TABLE IF NOT EXISTS conversation_origin_acquisitions (
      session_id TEXT NOT NULL, fence INTEGER NOT NULL, origin_json TEXT NOT NULL, native_identity TEXT,
      PRIMARY KEY(session_id,fence)
    );
    CREATE TABLE IF NOT EXISTS conversation_origin_enrollments (
      session_id TEXT NOT NULL, epoch TEXT NOT NULL, end_sequence INTEGER NOT NULL,
      origin_json TEXT NOT NULL, PRIMARY KEY(session_id,epoch)
    );
    CREATE TABLE IF NOT EXISTS conversation_origin_bindings (
      session_id TEXT NOT NULL, native_binding_generation INTEGER NOT NULL, key_kind TEXT NOT NULL, key_id TEXT NOT NULL,
      origin_json TEXT NOT NULL, PRIMARY KEY(session_id,native_binding_generation,key_kind,key_id)
    );
    CREATE TABLE IF NOT EXISTS conversation_origin_correlations (
      session_id TEXT NOT NULL, fence INTEGER NOT NULL, submission_id TEXT NOT NULL,
      turn_key TEXT NOT NULL, scope_json TEXT, resolved INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(session_id,fence,submission_id,turn_key)
    );
    CREATE TABLE IF NOT EXISTS conversation_origin_batch_envelopes (
      session_id TEXT NOT NULL, epoch TEXT NOT NULL, sequence INTEGER NOT NULL,
      mutation_count INTEGER NOT NULL CHECK(mutation_count > 0 AND mutation_count <= 200),
      PRIMARY KEY(session_id,epoch,sequence)
    );
    CREATE TABLE IF NOT EXISTS conversation_origin_rows (
      session_id TEXT NOT NULL, epoch TEXT NOT NULL, sequence INTEGER NOT NULL,
      atom_path TEXT NOT NULL, keys_json TEXT NOT NULL, origin_json TEXT,
      conversation_id TEXT, context_generation INTEGER, native_binding_generation INTEGER,
      PRIMARY KEY(session_id,epoch,sequence,atom_path)
    );
    CREATE INDEX IF NOT EXISTS conversation_origin_unresolved
      ON conversation_origin_rows(session_id,sequence) WHERE origin_json IS NULL;
  `
}
