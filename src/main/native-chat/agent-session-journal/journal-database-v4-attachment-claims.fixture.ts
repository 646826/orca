// Frozen table initializer from Orca aecb9924858d9c34adeea704b8593fd25c0b1f01.
import type Database from '../../sqlite/sync-database'

export function ensureAgentSessionAttachmentClaimTables(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS agent_session_attachment_claims (
  upload_id  TEXT    NOT NULL,
  session_id TEXT    NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (upload_id, session_id)
);
CREATE TABLE IF NOT EXISTS agent_session_attachment_sweeps (
  upload_id  TEXT    NOT NULL PRIMARY KEY,
  started_at INTEGER NOT NULL
);
`)
}
