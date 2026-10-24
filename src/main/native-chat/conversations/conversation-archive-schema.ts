export function createConversationArchiveTablesSql(): string {
  return `CREATE TABLE IF NOT EXISTS conversation_archive_deletions (
    operation_key TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
    context_generation INTEGER NOT NULL, archive_revision INTEGER NOT NULL DEFAULT 0, owner_cursor TEXT NOT NULL DEFAULT '',
    phase TEXT NOT NULL CHECK(phase IN ('inventory','cleanup','complete')),
    UNIQUE(conversation_id,context_generation)
  );
  CREATE INDEX IF NOT EXISTS conversation_archive_revision ON conversation_archive_deletions(conversation_id,archive_revision DESC);
  CREATE TABLE IF NOT EXISTS conversation_archive_resources (
    operation_key TEXT NOT NULL REFERENCES conversation_archive_deletions(operation_key),
    owner_id TEXT NOT NULL, PRIMARY KEY(operation_key,owner_id)
  );
  CREATE TABLE IF NOT EXISTS conversation_archive_epochs (
    operation_key TEXT NOT NULL REFERENCES conversation_archive_deletions(operation_key),
    session_id TEXT NOT NULL, epoch TEXT NOT NULL, PRIMARY KEY(operation_key,session_id,epoch)
  );
  CREATE TABLE IF NOT EXISTS conversation_archive_audit (
    operation_key TEXT NOT NULL REFERENCES conversation_archive_deletions(operation_key),
    kind TEXT NOT NULL,evidence_id TEXT NOT NULL,metadata_json TEXT NOT NULL,
    PRIMARY KEY(operation_key,kind,evidence_id)
  );
  CREATE TRIGGER IF NOT EXISTS conversation_archive_identity BEFORE UPDATE ON conversation_archive_deletions
    WHEN NEW.operation_key!=OLD.operation_key OR NEW.conversation_id!=OLD.conversation_id OR NEW.context_generation!=OLD.context_generation OR NEW.archive_revision!=OLD.archive_revision
    BEGIN SELECT RAISE(ABORT,'Immutable archive tombstone identity'); END;
  CREATE TRIGGER IF NOT EXISTS conversation_archive_no_delete BEFORE DELETE ON conversation_archive_deletions
    BEGIN SELECT RAISE(ABORT,'Archive deletion cannot be undone'); END;
  CREATE TRIGGER IF NOT EXISTS conversation_archive_no_replace BEFORE INSERT ON conversation_archive_deletions
    WHEN EXISTS(SELECT 1 FROM conversation_archive_deletions WHERE operation_key=NEW.operation_key OR (conversation_id=NEW.conversation_id AND context_generation=NEW.context_generation))
    BEGIN SELECT RAISE(ABORT,'Archive deletion already exists'); END;
  CREATE TRIGGER IF NOT EXISTS conversation_archive_audit_immutable BEFORE UPDATE ON conversation_archive_audit
    BEGIN SELECT RAISE(ABORT,'Immutable archive audit'); END;
  CREATE TRIGGER IF NOT EXISTS conversation_archive_audit_no_replace BEFORE INSERT ON conversation_archive_audit
    WHEN EXISTS(SELECT 1 FROM conversation_archive_audit WHERE operation_key=NEW.operation_key AND kind=NEW.kind AND evidence_id=NEW.evidence_id)
    BEGIN SELECT RAISE(ABORT,'Immutable archive audit'); END;
  CREATE TRIGGER IF NOT EXISTS conversation_archive_audit_no_delete BEFORE DELETE ON conversation_archive_audit
    BEGIN SELECT RAISE(ABORT,'Immutable archive audit'); END;`
}

export function createConversationArchiveLookupIndexesSql(): string {
  return `CREATE INDEX IF NOT EXISTS conversation_manifests_archive_scope ON conversation_context_manifests(json_extract(manifest_json,'$.conversationId'),json_extract(manifest_json,'$.contextGeneration'));
  CREATE INDEX IF NOT EXISTS conversation_previews_archive_scope ON conversation_preparation_previews(json_extract(manifest_json,'$.conversationId'),json_extract(manifest_json,'$.contextGeneration'));
  CREATE INDEX IF NOT EXISTS conversation_indexes_archive_scope ON conversation_manifest_part_indexes(conversation_id,context_generation,index_id);`
}
