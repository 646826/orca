import { conversationRepresentationCoverageDigest } from './conversation-context-coverage-identity'
import { createConversationIndexRetentionTablesSql } from './conversation-index-retention'
import { createHash, randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import type Database from '../../sqlite/sync-database'
import type {
  ConversationContextRepresentation,
  ConversationEvidenceGap
} from '../../../shared/conversation-handoff'
import { runJournalTransaction } from '../agent-session-journal/journal-transaction'
import { conversationManifestSchema } from './conversation-context-schema'
import { conversationContextDigest } from './conversation-context-consent'

export type ConversationManifestPartIndex = {
  indexId: string
  partCount: number
  rootDigest: string
}
export function createConversationManifestPartTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS conversation_manifest_part_indexes (
 index_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, context_generation INTEGER NOT NULL,
 source_revision TEXT NOT NULL, part_count INTEGER NOT NULL DEFAULT 0, root_digest TEXT
);
CREATE TABLE IF NOT EXISTS conversation_manifest_parts (
 index_id TEXT NOT NULL REFERENCES conversation_manifest_part_indexes(index_id),
 ordinal INTEGER NOT NULL, source_key TEXT NOT NULL, representation_digest TEXT NOT NULL, part_json TEXT NOT NULL,
 PRIMARY KEY(index_id,ordinal), UNIQUE(index_id,source_key)
);
${createConversationIndexRetentionTablesSql()}
CREATE INDEX IF NOT EXISTS conversation_manifest_part_coverage_lookup ON conversation_manifest_parts(source_key,representation_digest,index_id);
CREATE TRIGGER IF NOT EXISTS conversation_manifest_part_no_update BEFORE UPDATE ON conversation_manifest_parts
BEGIN SELECT RAISE(ABORT,'manifest part is immutable'); END;
CREATE TRIGGER IF NOT EXISTS conversation_manifest_part_no_replace BEFORE INSERT ON conversation_manifest_parts
WHEN EXISTS(SELECT 1 FROM conversation_manifest_parts WHERE index_id=NEW.index_id AND (ordinal=NEW.ordinal OR source_key=NEW.source_key))
 OR EXISTS(SELECT 1 FROM conversation_manifest_part_indexes WHERE index_id=NEW.index_id AND root_digest IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'manifest part is immutable'); END;
CREATE TRIGGER IF NOT EXISTS conversation_manifest_part_no_delete BEFORE DELETE ON conversation_manifest_parts
WHEN EXISTS(SELECT 1 FROM conversation_manifest_compilations WHERE index_id=OLD.index_id)
BEGIN SELECT RAISE(ABORT,'sealed manifest part is immutable'); END;
CREATE TRIGGER IF NOT EXISTS conversation_manifest_index_sealed BEFORE UPDATE ON conversation_manifest_part_indexes
WHEN OLD.root_digest IS NOT NULL
BEGIN SELECT RAISE(ABORT,'manifest index is immutable'); END;
CREATE TRIGGER IF NOT EXISTS conversation_manifest_index_no_replace BEFORE INSERT ON conversation_manifest_part_indexes
WHEN EXISTS(SELECT 1 FROM conversation_manifest_part_indexes WHERE index_id=NEW.index_id)
BEGIN SELECT RAISE(ABORT,'manifest index is immutable'); END;
`
}
/** Only this operation's unpublished derived staging rows may be discarded. */
export async function discardConversationManifestParts(
  db: Database.Database,
  indexId: string
): Promise<void> {
  if (db.isTransaction) {
    throw new Error('Staging cleanup must run outside writer transaction')
  }
  if (
    db.prepare('SELECT 1 FROM conversation_manifest_compilations WHERE index_id=?').get(indexId) ||
    db.prepare('SELECT 1 FROM conversation_manifest_index_retention WHERE index_id=?').get(indexId)
  ) {
    throw new Error('Published compilation cannot be discarded')
  }
  while (true) {
    const result = db
      .prepare(
        'DELETE FROM conversation_manifest_parts WHERE index_id=? AND ordinal IN (SELECT ordinal FROM conversation_manifest_parts WHERE index_id=? ORDER BY ordinal LIMIT 128)'
      )
      .run(indexId, indexId)
    if (result.changes === 0) {
      break
    }
    await setImmediate()
  }
  while (true) {
    const removed = db
      .prepare(
        'DELETE FROM conversation_manifest_source_boundaries WHERE rowid IN (SELECT rowid FROM conversation_manifest_source_boundaries WHERE index_id=? LIMIT 128)'
      )
      .run(indexId)
    if (removed.changes === 0) {
      break
    }
    await setImmediate()
  }
  db.prepare('DELETE FROM conversation_manifest_part_indexes WHERE index_id=?').run(indexId)
}
/** Derived staging metadata only. Sealing does not confer source, disclosure or delivery authority. */
export function createConversationManifestParts(
  db: Database.Database,
  scope: {
    conversationId: string
    contextGeneration: number
    sourceRevision: string
  }
): string {
  if (
    !scope.conversationId ||
    !Number.isSafeInteger(scope.contextGeneration) ||
    scope.contextGeneration < 1 ||
    !scope.sourceRevision
  ) {
    throw new Error('Invalid manifest index scope')
  }
  const id = randomUUID()
  db.prepare(
    'INSERT INTO conversation_manifest_part_indexes(index_id,conversation_id,context_generation,source_revision) VALUES(?,?,?,?)'
  ).run(id, scope.conversationId, scope.contextGeneration, scope.sourceRevision)
  return id
}
export function appendConversationManifestParts(
  db: Database.Database,
  indexId: string,
  expectedCount: number,
  parts: readonly ConversationContextRepresentation[],
  gaps: readonly ConversationEvidenceGap[] = []
): void {
  if (
    db.isTransaction ||
    parts.length < 1 ||
    parts.length > 128 ||
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 0
  ) {
    throw new Error('Invalid manifest page')
  }
  // Bound the serialized page before taking the writer lock.
  const encoded = parts.map((part) => {
    const checked = conversationManifestSchema.shape.projection.element.parse(part)
    const sourceKey = conversationContextDigest(checked.version.source)
    const captured = gaps.filter((gap) => conversationContextDigest(gap.source) === sourceKey)
    const json = JSON.stringify({ part: checked, gaps: captured })
    if (Buffer.byteLength(json) > 1024 * 1024) {
      throw new Error('Manifest part exceeds resource limit')
    }
    return {
      key: conversationContextDigest(checked.version),
      representationDigest: conversationRepresentationCoverageDigest(checked),
      source: checked.version.source,
      json
    }
  })
  if (encoded.reduce((n, row) => n + Buffer.byteLength(row.json), 0) > 2 * 1024 * 1024) {
    throw new Error('Manifest page exceeds resource limit')
  }
  runJournalTransaction(db, () => {
    const index = db
      .prepare(
        'SELECT part_count,root_digest FROM conversation_manifest_part_indexes WHERE index_id=?'
      )
      .get(indexId)
    if (!index || index.root_digest !== null || index.part_count !== expectedCount) {
      throw new Error('Manifest index changed')
    }
    const insert = db.prepare('INSERT INTO conversation_manifest_parts VALUES(?,?,?,?,?)')
    encoded.forEach((row, i) => {
      insert.run(indexId, expectedCount + i + 1, row.key, row.representationDigest, row.json)
      db.prepare(`INSERT INTO conversation_manifest_source_boundaries VALUES(?,?,?,?)
        ON CONFLICT(index_id,session_id,epoch) DO UPDATE SET end_sequence=MAX(end_sequence,excluded.end_sequence)`).run(
        indexId,
        row.source.sessionId,
        row.source.epoch,
        row.source.sequence
      )
    })
    db.prepare('UPDATE conversation_manifest_part_indexes SET part_count=? WHERE index_id=?').run(
      expectedCount + parts.length,
      indexId
    )
  })
}
export function readConversationManifestParts(
  db: Database.Database,
  indexId: string,
  after: number,
  limit: number
): { ordinal: number; part: ConversationContextRepresentation; gaps: ConversationEvidenceGap[] }[] {
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 128
  ) {
    throw new Error('Invalid manifest page cursor')
  }
  const sizes = db
    .prepare(
      'SELECT ordinal,length(CAST(part_json AS BLOB)) bytes FROM conversation_manifest_parts WHERE index_id=? AND ordinal>? ORDER BY ordinal LIMIT ?'
    )
    .all(indexId, after, limit)
  let bytes = 0,
    end = after
  for (const row of sizes) {
    if (typeof row.ordinal !== 'number' || typeof row.bytes !== 'number') {
      throw new Error('Corrupt manifest part')
    }
    if (bytes + row.bytes > 2 * 1024 * 1024) {
      break
    }
    bytes += row.bytes
    end = row.ordinal
  }
  if (sizes.length && end === after) {
    throw new Error('Manifest part exceeds page resource limit')
  }
  return db
    .prepare(
      'SELECT ordinal,part_json FROM conversation_manifest_parts WHERE index_id=? AND ordinal>? AND ordinal<=? ORDER BY ordinal'
    )
    .all(indexId, after, end)
    .map((row) => {
      if (typeof row.ordinal !== 'number' || typeof row.part_json !== 'string') {
        throw new Error('Corrupt manifest part')
      }
      const parsed = JSON.parse(row.part_json)
      return {
        ordinal: row.ordinal,
        part: conversationManifestSchema.shape.projection.element.parse(parsed.part),
        gaps: conversationManifestSchema.shape.gaps.parse(parsed.gaps)
      }
    })
}
export async function sealConversationManifestParts(
  db: Database.Database,
  indexId: string,
  signal: AbortSignal
): Promise<ConversationManifestPartIndex> {
  if (db.isTransaction) {
    throw new Error('Manifest sealing must run outside writer transaction')
  }
  const index = db
    .prepare(
      'SELECT part_count,root_digest,conversation_id,context_generation,source_revision FROM conversation_manifest_part_indexes WHERE index_id=?'
    )
    .get(indexId)
  if (!index || typeof index.part_count !== 'number') {
    throw new Error('Unknown manifest index')
  }
  if (typeof index.root_digest === 'string') {
    return { indexId, partCount: index.part_count, rootDigest: index.root_digest }
  }
  const hash = createHash('sha256').update(
    conversationContextDigest({
      conversationId: index.conversation_id,
      contextGeneration: index.context_generation,
      sourceRevision: index.source_revision
    })
  )
  let after = 0
  while (after < index.part_count) {
    signal.throwIfAborted()
    const page = readConversationManifestParts(db, indexId, after, 128)
    if (page.length === 0) {
      throw new Error('Missing manifest part')
    }
    for (const entry of page) {
      if (entry.ordinal !== after + 1) {
        throw new Error('Missing manifest part')
      }
      hash.update(conversationContextDigest(entry))
      after = entry.ordinal
    }
    await setImmediate()
  }
  signal.throwIfAborted()
  const rootDigest = hash.digest('hex')
  runJournalTransaction(db, () => {
    const updated = db
      .prepare(
        'UPDATE conversation_manifest_part_indexes SET root_digest=? WHERE index_id=? AND part_count=? AND root_digest IS NULL'
      )
      .run(rootDigest, indexId, after)
    if (updated.changes !== 1) {
      throw new Error('Manifest index changed while sealing')
    }
  })
  return { indexId, partCount: after, rootDigest }
}
export { readConversationManifestIndexSummary } from './conversation-context-index-summary'
