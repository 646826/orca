import type Database from '../../sqlite/sync-database'
import type { ConversationEvidenceVersion } from '../../../shared/conversation-handoff'
import type { ConversationAttachmentVersion } from '../agent-session-attachments/conversation-attachment-claims'
import type { ConversationExportArtifact } from './conversation-artifact-disclosure'
import { ConversationExportError } from './conversation-artifact-disclosure'
import type { ConversationExportedRow } from './conversation-context-export'
import { readConversation } from './conversation-read-model'

export function createConversationExportProofTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS conversation_export_sources (
 owner_id TEXT NOT NULL,
 upload_id TEXT NOT NULL,
 name TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 context_generation INTEGER NOT NULL,
 session_id TEXT NOT NULL,
 epoch TEXT NOT NULL,
 sequence INTEGER NOT NULL,
 row_sha256 TEXT NOT NULL,
 frame_offset INTEGER NOT NULL,
 byte_offset INTEGER NOT NULL,
 byte_length INTEGER NOT NULL,
 PRIMARY KEY(owner_id,session_id,epoch,sequence),
 FOREIGN KEY(owner_id,upload_id,name) REFERENCES conversation_attachment_claims(owner_id,upload_id,name) ON DELETE CASCADE
);
CREATE TRIGGER IF NOT EXISTS conversation_export_source_no_update BEFORE UPDATE ON conversation_export_sources
BEGIN SELECT RAISE(ABORT,'export source proof is immutable'); END;
CREATE TRIGGER IF NOT EXISTS conversation_export_source_no_replace BEFORE INSERT ON conversation_export_sources
WHEN EXISTS(SELECT 1 FROM conversation_export_sources WHERE owner_id=NEW.owner_id AND session_id=NEW.session_id AND epoch=NEW.epoch AND sequence=NEW.sequence)
BEGIN SELECT RAISE(ABORT,'export source proof is immutable'); END;
`
}
/** Trusted exporter only: bytes and framing were validated before the publication transaction. */
export function recordConversationExportSources(
  db: Database.Database,
  input: {
    artifact: ConversationExportArtifact
    conversationId: string
    contextGeneration: number
    rows: readonly ConversationExportedRow[]
  }
): void {
  if (!db.isTransaction) {
    throw new ConversationExportError('scope')
  }
  const { artifact } = input
  if (readConversation(db, input.conversationId)?.contextGeneration !== input.contextGeneration) {
    throw new ConversationExportError('scope')
  }
  const claim = db
    .prepare(
      'SELECT sha256,byte_length FROM conversation_attachment_claims WHERE owner_id=? AND upload_id=? AND name=?'
    )
    .get(artifact.ownerId, artifact.version.uploadId, artifact.version.name)
  if (
    claim?.sha256 !== artifact.version.sha256 ||
    claim?.byte_length !== artifact.version.byteLength
  ) {
    throw new ConversationExportError('scope')
  }
  for (const row of input.rows) {
    const source = row.version.source
    if (
      !Number.isSafeInteger(row.frameOffset) ||
      !Number.isSafeInteger(row.byteOffset) ||
      !Number.isSafeInteger(row.byteLength) ||
      row.frameOffset < 0 ||
      row.byteOffset <= row.frameOffset ||
      row.byteLength < 1 ||
      row.byteOffset + row.byteLength > artifact.version.byteLength
    ) {
      throw new ConversationExportError('scope')
    }
    const version = db
      .prepare(
        'SELECT sha256,byte_length FROM conversation_source_versions WHERE session_id=? AND epoch=? AND sequence=?'
      )
      .get(source.sessionId, source.epoch, source.sequence)
    if (version?.sha256 !== row.version.sha256 || version?.byte_length !== row.byteLength) {
      throw new ConversationExportError('scope')
    }
    db.prepare('INSERT INTO conversation_export_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
      artifact.ownerId,
      artifact.version.uploadId,
      artifact.version.name,
      input.conversationId,
      input.contextGeneration,
      source.sessionId,
      source.epoch,
      source.sequence,
      row.version.sha256,
      row.frameOffset,
      row.byteOffset,
      row.byteLength
    )
  }
}
export type ConversationExportProof = {
  artifactVersion: ConversationAttachmentVersion
  frameOffset: number
  byteOffset: number
  byteLength: number
}
export function readConversationExportProof(
  db: Database.Database,
  input: {
    ownerId: string
    conversationId: string
    contextGeneration: number
    version: ConversationEvidenceVersion
  }
): ConversationExportProof | null {
  if (readConversation(db, input.conversationId)?.contextGeneration !== input.contextGeneration) {
    return null
  }
  const source = input.version.source
  const row = db
    .prepare(`SELECT p.upload_id,p.name,p.frame_offset,p.byte_offset,p.byte_length,c.sha256,c.byte_length artifact_length FROM conversation_export_sources p
    JOIN conversation_attachment_claims c ON c.owner_id=p.owner_id AND c.upload_id=p.upload_id AND c.name=p.name
    JOIN conversation_source_versions v ON v.session_id=p.session_id AND v.epoch=p.epoch AND v.sequence=p.sequence AND v.sha256=p.row_sha256 AND v.byte_length=p.byte_length
    WHERE p.owner_id=? AND p.conversation_id=? AND p.context_generation=? AND p.session_id=? AND p.epoch=? AND p.sequence=? AND p.row_sha256=?`)
    .get(
      input.ownerId,
      input.conversationId,
      input.contextGeneration,
      source.sessionId,
      source.epoch,
      source.sequence,
      input.version.sha256
    )
  if (!row) {
    return null
  }
  if (
    typeof row.upload_id !== 'string' ||
    typeof row.name !== 'string' ||
    typeof row.sha256 !== 'string' ||
    typeof row.artifact_length !== 'number' ||
    typeof row.frame_offset !== 'number' ||
    typeof row.byte_offset !== 'number' ||
    typeof row.byte_length !== 'number'
  ) {
    throw new ConversationExportError('corrupt-source')
  }
  return {
    artifactVersion: {
      uploadId: row.upload_id,
      name: row.name,
      sha256: row.sha256,
      byteLength: row.artifact_length
    },
    frameOffset: row.frame_offset,
    byteOffset: row.byte_offset,
    byteLength: row.byte_length
  }
}
