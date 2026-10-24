import { conversationRepresentationCoverageDigest } from './conversation-context-coverage-identity'
import type Database from '../../sqlite/sync-database'
import type {
  ConversationContextManifest,
  ConversationCoverageEntry
} from '../../../shared/conversation-handoff'
import { readConversationManifestParts } from './conversation-context-parts'

export function createConversationIndexedCoverageTablesSql(): string {
  return `CREATE TABLE IF NOT EXISTS conversation_context_index_receipts (
    manifest_id TEXT NOT NULL REFERENCES conversation_context_manifests(manifest_id),
    receipt_id TEXT NOT NULL, index_id TEXT NOT NULL REFERENCES conversation_manifest_part_indexes(index_id),
    root_digest TEXT NOT NULL, part_count INTEGER NOT NULL,
    PRIMARY KEY(manifest_id,receipt_id)
  );
  CREATE TRIGGER IF NOT EXISTS conversation_index_receipt_no_update BEFORE UPDATE ON conversation_context_index_receipts
  BEGIN SELECT RAISE(ABORT,'coverage receipt is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS conversation_index_receipt_no_replace BEFORE INSERT ON conversation_context_index_receipts
  WHEN EXISTS(SELECT 1 FROM conversation_context_index_receipts WHERE manifest_id=NEW.manifest_id AND receipt_id=NEW.receipt_id)
  BEGIN SELECT RAISE(ABORT,'coverage receipt is immutable'); END;`
}
/** Caller verified the whole representation plan, including prior coverage and live retrieval; a chunk acknowledgement is insufficient. */
export function recordConversationIndexReceipt(
  db: Database.Database,
  manifest: ConversationContextManifest,
  receiptId: string
): void {
  const index = manifest.evidenceIndex
  if (!db.isTransaction || !index) {
    throw new Error('Indexed coverage requires a transaction')
  }
  const stored = db
    .prepare(
      'SELECT index_id,root_digest,part_count FROM conversation_context_index_receipts WHERE manifest_id=? AND receipt_id=?'
    )
    .get(manifest.manifestId, receiptId)
  if (stored) {
    if (
      stored.index_id !== index.indexId ||
      stored.root_digest !== index.rootDigest ||
      stored.part_count !== index.partCount
    ) {
      throw new Error('Indexed coverage is immutable')
    }
    return
  }
  db.prepare('INSERT INTO conversation_context_index_receipts VALUES(?,?,?,?,?)').run(
    manifest.manifestId,
    receiptId,
    index.indexId,
    index.rootDigest,
    index.partCount
  )
}
/** Bounded join; the immutable part remains the representation authority, not a copied coverage row. */
export function readConversationIndexCoveragePage(
  db: Database.Database,
  manifest: ConversationContextManifest,
  receiptId: string,
  after: number,
  limit: number
): { ordinal: number; entry: ConversationCoverageEntry }[] {
  const index = manifest.evidenceIndex
  if (!index) {
    throw new Error('Manifest is not indexed')
  }
  const stored = db
    .prepare(
      'SELECT index_id,root_digest,part_count FROM conversation_context_index_receipts WHERE manifest_id=? AND receipt_id=?'
    )
    .get(manifest.manifestId, receiptId)
  if (!stored) {
    return []
  }
  if (
    stored.index_id !== index.indexId ||
    stored.root_digest !== index.rootDigest ||
    stored.part_count !== index.partCount
  ) {
    throw new Error('Indexed coverage is corrupt')
  }
  return readConversationManifestParts(db, index.indexId, after, limit).map(
    ({ ordinal, part }) => ({
      ordinal,
      entry: {
        manifestId: manifest.manifestId,
        receiptId,
        targetSessionId: manifest.target.sessionId,
        targetBindingDigest: manifest.targetBindingDigest,
        contextGeneration: manifest.contextGeneration,
        nativeBindingGeneration: manifest.target.nativeBindingGeneration,
        version: part.version,
        representation: part.representation,
        representationDigest: conversationRepresentationCoverageDigest(part)
      }
    })
  )
}
