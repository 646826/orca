export function createConversationPreparationTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS conversation_preparation_sources (
 owner_id TEXT PRIMARY KEY, operation_key TEXT NOT NULL, record_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_preparation_previews (
 manifest_id TEXT PRIMARY KEY, operation_key TEXT NOT NULL,
 source_owner_id TEXT NOT NULL REFERENCES conversation_preparation_sources(owner_id),
 manifest_json TEXT NOT NULL, target_json TEXT NOT NULL, trigger_json TEXT NOT NULL,
 proof_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversation_preparation_by_operation
 ON conversation_preparation_previews(operation_key);
CREATE TABLE IF NOT EXISTS conversation_preparation_consents (
 manifest_id TEXT PRIMARY KEY REFERENCES conversation_preparation_previews(manifest_id),
 consent_json TEXT NOT NULL
);
${['sources', 'previews', 'consents']
  .map(
    (name) => `
CREATE TRIGGER IF NOT EXISTS conversation_preparation_${name}_no_update
 BEFORE UPDATE ON conversation_preparation_${name}
 BEGIN SELECT RAISE(ABORT,'conversation preparation is immutable'); END;`
  )
  .join('\n')}
CREATE TRIGGER IF NOT EXISTS conversation_preparation_sources_no_replace
 BEFORE INSERT ON conversation_preparation_sources
 WHEN EXISTS(SELECT 1 FROM conversation_preparation_sources WHERE owner_id=NEW.owner_id)
 BEGIN SELECT RAISE(ABORT,'conversation preparation is immutable'); END;
CREATE TRIGGER IF NOT EXISTS conversation_preparation_previews_no_replace
 BEFORE INSERT ON conversation_preparation_previews
 WHEN EXISTS(SELECT 1 FROM conversation_preparation_previews WHERE manifest_id=NEW.manifest_id)
 BEGIN SELECT RAISE(ABORT,'conversation preparation is immutable'); END;
CREATE TRIGGER IF NOT EXISTS conversation_preparation_consents_no_replace
 BEFORE INSERT ON conversation_preparation_consents
 WHEN EXISTS(SELECT 1 FROM conversation_preparation_consents WHERE manifest_id=NEW.manifest_id)
 BEGIN SELECT RAISE(ABORT,'conversation preparation is immutable'); END;
`
}
