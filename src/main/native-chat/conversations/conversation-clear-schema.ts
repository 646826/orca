export function createConversationClearTablesSql(): string {
  return `CREATE TABLE IF NOT EXISTS conversation_clear_intents (
    operation_key TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
    record_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversation_clear_rows (
    session_id TEXT NOT NULL, epoch TEXT NOT NULL, sequence INTEGER NOT NULL,
    operation_key TEXT NOT NULL REFERENCES conversation_clear_intents(operation_key),
    origin_json TEXT NOT NULL, retention_owner_id TEXT NOT NULL,
    PRIMARY KEY(session_id,epoch,sequence)
  );
  CREATE TRIGGER IF NOT EXISTS conversation_clear_rows_immutable BEFORE UPDATE ON conversation_clear_rows
    BEGIN SELECT RAISE(ABORT,'Immutable conversation clear origin'); END;
  CREATE TRIGGER IF NOT EXISTS conversation_clear_rows_no_replace BEFORE INSERT ON conversation_clear_rows
    WHEN EXISTS (SELECT 1 FROM conversation_clear_rows WHERE session_id=NEW.session_id AND epoch=NEW.epoch AND sequence=NEW.sequence)
    BEGIN SELECT RAISE(ABORT,'Immutable conversation clear origin'); END;`
}
