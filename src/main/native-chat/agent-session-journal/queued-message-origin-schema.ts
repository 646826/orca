import { z } from 'zod'
import type Database from '../../sqlite/sync-database'

export const OriginSchema = z
  .object({
    birthDigest: z.string(),
    boundaryDigest: z.string(),
    conversationId: z.string().nullable(),
    contextGeneration: z.number().int().positive().nullable()
  })
  .refine((value) => (value.conversationId === null) === (value.contextGeneration === null))
export type QueuedDraftOrigin = z.infer<typeof OriginSchema>

export function createQueuedMessageOriginTablesSql(): string {
  return `CREATE TABLE IF NOT EXISTS queued_message_origins (
 session_id TEXT NOT NULL, message_id TEXT NOT NULL, origin_json TEXT,
 admitted_at INTEGER, conversation_origin_json TEXT,
 PRIMARY KEY(session_id,message_id));
 CREATE TRIGGER IF NOT EXISTS queued_message_origins_immutable BEFORE UPDATE ON queued_message_origins
 BEGIN SELECT RAISE(ABORT,'immutable queued draft origin'); END;
 CREATE TRIGGER IF NOT EXISTS queued_message_origins_no_replace BEFORE INSERT ON queued_message_origins
 WHEN EXISTS(SELECT 1 FROM queued_message_origins WHERE session_id=NEW.session_id AND message_id=NEW.message_id)
 BEGIN SELECT RAISE(ABORT,'queued draft origin already exists'); END;
 CREATE TABLE IF NOT EXISTS queued_message_evidence (
 session_id TEXT NOT NULL, message_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 body_json TEXT, options_json TEXT, admitted_at INTEGER,
 source_epoch TEXT, source_sequence INTEGER,
 PRIMARY KEY(session_id,message_id,fingerprint));
 CREATE TABLE IF NOT EXISTS queued_message_evidence_sources (
 session_id TEXT NOT NULL, message_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 epoch TEXT NOT NULL, sequence INTEGER NOT NULL,
 PRIMARY KEY(session_id,epoch,sequence),
 FOREIGN KEY(session_id,epoch,sequence) REFERENCES journal_rows(session_id,epoch,seq) ON DELETE CASCADE);
 CREATE INDEX IF NOT EXISTS queued_message_evidence_source_version ON queued_message_evidence_sources(session_id,message_id,fingerprint);
 CREATE TABLE IF NOT EXISTS queued_message_evidence_owners (
 owner_id TEXT NOT NULL,session_id TEXT NOT NULL,message_id TEXT NOT NULL,fingerprint TEXT NOT NULL,
 source_epoch TEXT,source_sequence INTEGER,queue_order_json TEXT,
 PRIMARY KEY(owner_id));
 CREATE TRIGGER IF NOT EXISTS queued_message_evidence_owner_immutable BEFORE UPDATE ON queued_message_evidence_owners
 BEGIN SELECT RAISE(ABORT,'immutable queued draft owner'); END;
 CREATE TRIGGER IF NOT EXISTS queued_message_evidence_owner_no_replace BEFORE INSERT ON queued_message_evidence_owners
 WHEN EXISTS(SELECT 1 FROM queued_message_evidence_owners WHERE owner_id=NEW.owner_id)
 BEGIN SELECT RAISE(ABORT,'queued draft owner already exists'); END;
 CREATE TRIGGER IF NOT EXISTS queued_message_evidence_source_pruned AFTER DELETE ON queued_message_evidence_sources
 BEGIN DELETE FROM queued_message_evidence WHERE session_id=OLD.session_id AND message_id=OLD.message_id AND fingerprint=OLD.fingerprint
   AND NOT EXISTS(SELECT 1 FROM queued_message_evidence_sources s WHERE s.session_id=OLD.session_id AND s.message_id=OLD.message_id AND s.fingerprint=OLD.fingerprint)
   AND NOT EXISTS(SELECT 1 FROM queued_message_evidence_owners o WHERE o.session_id=OLD.session_id AND o.message_id=OLD.message_id AND o.fingerprint=OLD.fingerprint); END;
 CREATE TRIGGER IF NOT EXISTS queued_message_evidence_sources_immutable BEFORE UPDATE ON queued_message_evidence_sources
 BEGIN SELECT RAISE(ABORT,'immutable queued draft source'); END;
 CREATE TRIGGER IF NOT EXISTS queued_message_evidence_sources_no_replace BEFORE INSERT ON queued_message_evidence_sources
 WHEN EXISTS(SELECT 1 FROM queued_message_evidence_sources WHERE session_id=NEW.session_id AND epoch=NEW.epoch AND sequence=NEW.sequence)
 BEGIN SELECT RAISE(ABORT,'queued draft source already exists'); END;
 CREATE TRIGGER IF NOT EXISTS queued_message_evidence_immutable BEFORE UPDATE ON queued_message_evidence
 BEGIN SELECT RAISE(ABORT,'immutable queued draft evidence'); END;
 CREATE TRIGGER IF NOT EXISTS queued_message_evidence_no_replace BEFORE INSERT ON queued_message_evidence
 WHEN EXISTS(SELECT 1 FROM queued_message_evidence WHERE session_id=NEW.session_id AND message_id=NEW.message_id AND fingerprint=NEW.fingerprint)
 BEGIN SELECT RAISE(ABORT,'queued draft evidence already exists'); END;`
}

/** Rebuild the child table before legacy adoption can cascade-delete its immutable origin. */
export function migrateQueuedMessageOrigins(db: Database.Database): void {
  if (!db.isTransaction) {
    throw new Error('queued origin migration requires transaction')
  }
  const columns = db.prepare('PRAGMA table_info(queued_message_origins)').all()
  if (columns.length && !columns.some((column) => column.name === 'admitted_at')) {
    db.exec(`DROP TRIGGER IF EXISTS queued_message_origins_immutable;
      DROP TRIGGER IF EXISTS queued_message_origins_no_replace;
      ALTER TABLE queued_message_origins RENAME TO queued_message_origins_legacy;`)
    db.exec(createQueuedMessageOriginTablesSql())
    db.exec(`INSERT INTO queued_message_origins(session_id,message_id,origin_json,admitted_at)
      SELECT o.session_id,o.message_id,o.origin_json,q.created_at FROM queued_message_origins_legacy o
      LEFT JOIN queued_messages q ON q.session_id=o.session_id AND q.message_id=o.message_id;
      DROP TABLE queued_message_origins_legacy;`)
  } else {
    db.exec(createQueuedMessageOriginTablesSql())
  }
}
