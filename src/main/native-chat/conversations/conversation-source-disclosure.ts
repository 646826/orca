import type Database from '../../sqlite/sync-database'
import type { ConversationSourceRef } from '../../../shared/conversation-record'
import type { ConversationEvidenceVersion } from '../../../shared/conversation-handoff'
import {
  ConversationExportError,
  type ConversationExportArtifact
} from './conversation-artifact-disclosure'
import { readConversation } from './conversation-read-model'

function sourceKey(source: ConversationSourceRef): string {
  return JSON.stringify([
    source.sessionId,
    source.epoch,
    source.sequence,
    source.itemId ?? null,
    source.itemRevision ?? null,
    source.batchIndex ?? null
  ])
}
/** Host policy output, never a renderer-provided authorization or a secret scanner. */
export type ConversationSourceDisclosure = {
  version: ConversationEvidenceVersion
  contextGeneration: number
  targetBindingDigest: string
  action: 'include' | 'exclude'
  reason: 'user-policy' | 'known-sensitive' | 'cross-scope'
  critical: boolean
}
export type ConversationDisclosureAuthority = {
  targetBindingDigest: string
  resolve: (source: ConversationSourceRef) => ConversationSourceDisclosure | null
}
export function resolveConversationDisclosure(
  input: {
    disclosure?: ConversationDisclosureAuthority
    contextGeneration: number
  },
  source: ConversationSourceRef
): ConversationSourceDisclosure {
  const authority = input.disclosure
  const fact = authority?.resolve(source)
  if (
    !authority ||
    !fact ||
    !/^[a-f0-9]{64}$/.test(authority.targetBindingDigest) ||
    fact.targetBindingDigest !== authority.targetBindingDigest ||
    fact.contextGeneration !== input.contextGeneration ||
    !/^[a-f0-9]{64}$/.test(fact.version.sha256) ||
    sourceKey(fact.version.source) !== sourceKey(source) ||
    (fact.action === 'include' && fact.reason !== 'user-policy')
  ) {
    throw new ConversationExportError('scope')
  }
  return structuredClone(fact)
}
export function createConversationExportDisclosureTablesSql(): string {
  return `CREATE TABLE IF NOT EXISTS conversation_export_disclosures (
    owner_id TEXT NOT NULL, upload_id TEXT NOT NULL, name TEXT NOT NULL,
    conversation_id TEXT NOT NULL, context_generation INTEGER NOT NULL,
    target_binding_digest TEXT NOT NULL, source_json TEXT NOT NULL, row_sha256 TEXT NOT NULL,
    decision_json TEXT NOT NULL,
    PRIMARY KEY(owner_id,source_json),
    FOREIGN KEY(owner_id,upload_id,name) REFERENCES conversation_attachment_claims(owner_id,upload_id,name) ON DELETE CASCADE
  );
  CREATE TRIGGER IF NOT EXISTS conversation_disclosure_no_update BEFORE UPDATE ON conversation_export_disclosures
  BEGIN SELECT RAISE(ABORT,'disclosure is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS conversation_disclosure_no_replace BEFORE INSERT ON conversation_export_disclosures
  WHEN EXISTS(SELECT 1 FROM conversation_export_disclosures WHERE owner_id=NEW.owner_id AND source_json=NEW.source_json)
  BEGIN SELECT RAISE(ABORT,'disclosure is immutable'); END;`
}
export function recordConversationExportDisclosures(
  db: Database.Database,
  input: {
    artifact: ConversationExportArtifact
    conversationId: string
    contextGeneration: number
    decisions: readonly ConversationSourceDisclosure[]
  }
): void {
  if (
    !db.isTransaction ||
    readConversation(db, input.conversationId)?.contextGeneration !== input.contextGeneration
  ) {
    throw new ConversationExportError('scope')
  }
  const { artifact } = input
  for (const fact of input.decisions) {
    if (fact.contextGeneration !== input.contextGeneration) {
      throw new ConversationExportError('scope')
    }
    db.prepare('INSERT INTO conversation_export_disclosures VALUES(?,?,?,?,?,?,?,?,?)').run(
      artifact.ownerId,
      artifact.version.uploadId,
      artifact.version.name,
      input.conversationId,
      input.contextGeneration,
      fact.targetBindingDigest,
      sourceKey(fact.version.source),
      fact.version.sha256,
      JSON.stringify(fact)
    )
  }
}
export function readConversationExportDisclosure(
  db: Database.Database,
  input: {
    ownerId: string
    conversationId: string
    contextGeneration: number
    targetBindingDigest: string
    version: ConversationEvidenceVersion
  }
): ConversationSourceDisclosure | null {
  if (readConversation(db, input.conversationId)?.contextGeneration !== input.contextGeneration) {
    return null
  }
  const row = db
    .prepare(`SELECT json_extract(d.decision_json,'$.action') action, json_extract(d.decision_json,'$.reason') reason, json_extract(d.decision_json,'$.critical') critical FROM conversation_export_disclosures d
    JOIN conversation_attachment_claims c ON c.owner_id=d.owner_id AND c.upload_id=d.upload_id AND c.name=d.name
    WHERE d.owner_id=? AND d.conversation_id=? AND d.context_generation=? AND d.target_binding_digest=? AND d.source_json=? AND d.row_sha256=?`)
    .get(
      input.ownerId,
      input.conversationId,
      input.contextGeneration,
      input.targetBindingDigest,
      sourceKey(input.version.source),
      input.version.sha256
    )
  if (!row) {
    return null
  }
  if (
    (row.action !== 'include' && row.action !== 'exclude') ||
    (row.reason !== 'user-policy' &&
      row.reason !== 'known-sensitive' &&
      row.reason !== 'cross-scope') ||
    (row.critical !== 0 && row.critical !== 1)
  ) {
    throw new ConversationExportError('corrupt-source')
  }
  return {
    version: input.version,
    contextGeneration: input.contextGeneration,
    targetBindingDigest: input.targetBindingDigest,
    action: row.action,
    reason: row.reason,
    critical: row.critical === 1
  }
}
