import {
  prepareConversationIndexRetention,
  commitConversationIndexRetention,
  abandonConversationIndexRetention,
  assertConversationIndexRetention
} from './conversation-index-retention'
import { setImmediate } from 'node:timers/promises'
import type Database from '../../sqlite/sync-database'
import type { ConversationContextManifest } from '../../../shared/conversation-handoff'
import { runJournalTransaction } from '../agent-session-journal/journal-transaction'
import {
  assertConversationManifestAuthority,
  verifyConversationContextEvidence,
  type ConversationContextEvidenceReader
} from './conversation-context-authority'
import {
  assertConversationAuthorityRevision,
  assertConversationCoverageRevision,
  readConversationAuthorityRevision
} from './conversation-context-authority-revision'
import { hasConversationRepresentationCoverage } from './conversation-context-index-delta'
import { conversationRepresentationRequiresInline } from './conversation-context-constraints'
import { readConversationManifestParts } from './conversation-context-parts'
import {
  conversationContextDigest,
  conversationManifestIntegrity
} from './conversation-context-consent'

export function createConversationManifestIndexAuthorityTablesSql(): string {
  return `CREATE TABLE IF NOT EXISTS conversation_manifest_index_authorizations (
 manifest_id TEXT PRIMARY KEY,index_id TEXT NOT NULL REFERENCES conversation_manifest_part_indexes(index_id),
 root_digest TEXT NOT NULL,part_count INTEGER NOT NULL,authority_revision INTEGER NOT NULL,retention_owner TEXT NOT NULL REFERENCES conversation_manifest_index_retention(owner_id)
 );
 CREATE TABLE IF NOT EXISTS conversation_manifest_compilations (
 index_id TEXT PRIMARY KEY REFERENCES conversation_manifest_part_indexes(index_id),manifest_id TEXT NOT NULL,
 root_digest TEXT NOT NULL,source_count INTEGER NOT NULL,ordered_source_digest TEXT NOT NULL
 );
 CREATE TRIGGER IF NOT EXISTS conversation_compilation_no_update BEFORE UPDATE ON conversation_manifest_compilations
 BEGIN SELECT RAISE(ABORT,'context compilation is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS conversation_compilation_no_replace BEFORE INSERT ON conversation_manifest_compilations
 WHEN EXISTS(SELECT 1 FROM conversation_manifest_compilations WHERE index_id=NEW.index_id)
 BEGIN SELECT RAISE(ABORT,'context compilation is immutable'); END;`
}
function assertIndex(db: Database.Database, manifest: ConversationContextManifest): void {
  const index = manifest.evidenceIndex
  if (!index || !conversationManifestIntegrity(manifest)) {
    throw new Error('Invalid indexed manifest')
  }
  const stored = db
    .prepare('SELECT * FROM conversation_manifest_part_indexes WHERE index_id=?')
    .get(index.indexId)
  if (
    !stored ||
    stored.root_digest !== index.rootDigest ||
    stored.part_count !== index.partCount ||
    stored.conversation_id !== manifest.conversationId ||
    stored.context_generation !== manifest.contextGeneration ||
    stored.source_revision !== manifest.sourceRevision
  ) {
    throw new Error('Context index scope is unverified')
  }
  const compilation = db
    .prepare(
      'SELECT manifest_id,root_digest,source_count FROM conversation_manifest_compilations WHERE index_id=?'
    )
    .get(index.indexId)
  if (
    compilation?.manifest_id !== manifest.manifestId ||
    compilation.root_digest !== index.rootDigest ||
    compilation.source_count !== index.partCount
  ) {
    throw new Error('Indexed context policy is unverified')
  }
}
/** Validates all immutable parts outside the writer queue, then fences concurrent authority changes. */
export async function authorizeConversationManifestIndex(
  db: Database.Database,
  manifest: ConversationContextManifest,
  readEvidence: ConversationContextEvidenceReader,
  signal: AbortSignal
): Promise<void> {
  if (db.isTransaction) {
    throw new Error('Index validation must run outside writer transaction')
  }
  assertIndex(db, manifest)
  if (
    manifest.policy === 'full' &&
    (manifest.inputTokens === null ||
      (manifest.inputTokenConfidence !== 'exact' &&
        manifest.inputTokenConfidence !== 'upper-bound'))
  ) {
    throw new Error('Indexed full projection requires a verified input estimate')
  }
  const evidence = verifyConversationContextEvidence(db, manifest, readEvidence)
  const revision = readConversationAuthorityRevision(db)
  const index = manifest.evidenceIndex
  if (!index) {
    throw new Error('Missing index')
  }
  const retention = await prepareConversationIndexRetention(db, index, signal)
  try {
    const inline = new Set(manifest.projection.map((part) => conversationContextDigest(part)))
    let after = 0
    while (after < index.partCount) {
      signal.throwIfAborted()
      const page = readConversationManifestParts(db, index.indexId, after, 128)
      if (page.length === 0) {
        throw new Error('Missing indexed source')
      }
      for (const row of page) {
        if (row.ordinal !== after + 1 || row.gaps.some((gap) => gap.critical)) {
          throw new Error('Invalid indexed source')
        }
        if (row.part.text !== undefined && !inline.has(conversationContextDigest(row.part))) {
          if (
            manifest.policy !== 'budgeted' ||
            evidence.coverageRevision === undefined ||
            conversationRepresentationRequiresInline(manifest, row.part) ||
            !hasConversationRepresentationCoverage(
              db,
              { ...manifest, nativeIdentityDigest: evidence.nativeIdentityDigest },
              row.part
            )
          ) {
            throw new Error('Indexed exact or summarized evidence is not inline')
          }
          assertConversationCoverageRevision(db, evidence.coverageRevision)
        }
        if (
          manifest.policy !== 'budgeted' &&
          (manifest.policy !== 'full' ||
            (row.part.representation !== 'exact' &&
              row.part.representation !== 'transport-projected') ||
            row.part.text === undefined ||
            !inline.has(conversationContextDigest(row.part)) ||
            manifest.projection.length !== index.partCount ||
            inline.size !== index.partCount ||
            !manifest.budget ||
            manifest.budget.capacity === null ||
            manifest.budget.occupied === null ||
            manifest.budget.confidence === 'unknown')
        ) {
          throw new Error(
            'Indexed full projection requires complete exact inline evidence and verified budget'
          )
        }
        if (
          (row.part.representation === 'summarized' ||
            row.part.representation === 'retrievable-only') &&
          (manifest.target.retrieval !== 'verified' || !row.part.artifactId)
        ) {
          throw new Error('Indexed retrieval is unsupported')
        }
        if (
          (row.part.representation === 'missing' ||
            row.part.representation === 'retrievable-only') &&
          row.part.text !== undefined
        ) {
          throw new Error('Indexed representation is invalid')
        }
        if (
          row.part.representation === 'summarized' &&
          (!row.part.text || !row.part.spans.length)
        ) {
          throw new Error('Indexed summary lacks provenance')
        }
        after = row.ordinal
      }
      assertConversationManifestAuthority(db, {
        ...manifest,
        projection: page.map((row) => row.part)
      })
      await setImmediate()
    }
    signal.throwIfAborted()
    runJournalTransaction(db, () => {
      assertIndex(db, manifest)
      assertConversationAuthorityRevision(db, revision)
      if (evidence.coverageRevision !== undefined) {
        assertConversationCoverageRevision(db, evidence.coverageRevision)
      }
      assertConversationManifestAuthority(db, manifest)
      verifyConversationContextEvidence(db, manifest, readEvidence)
      commitConversationIndexRetention(db, index, retention)
      db.prepare(
        'INSERT INTO conversation_manifest_index_authorizations VALUES(?,?,?,?,?,?) ON CONFLICT(manifest_id) DO UPDATE SET authority_revision=excluded.authority_revision,retention_owner=excluded.retention_owner'
      ).run(
        manifest.manifestId,
        index.indexId,
        index.rootDigest,
        index.partCount,
        revision,
        retention.ownerId
      )
    })
  } catch (error) {
    await abandonConversationIndexRetention(db, retention)
    throw error
  }
}
/** O(1) index proof check. Caller also checks current conversation/source/target and host capabilities. */
export function assertConversationManifestIndexAuthorization(
  db: Database.Database,
  manifest: ConversationContextManifest
): void {
  if (!manifest.evidenceIndex) {
    return
  }
  assertIndex(db, manifest)
  const proof = db
    .prepare('SELECT * FROM conversation_manifest_index_authorizations WHERE manifest_id=?')
    .get(manifest.manifestId)
  if (
    !proof ||
    proof.index_id !== manifest.evidenceIndex.indexId ||
    proof.root_digest !== manifest.evidenceIndex.rootDigest ||
    proof.part_count !== manifest.evidenceIndex.partCount ||
    typeof proof.authority_revision !== 'number' ||
    typeof proof.retention_owner !== 'string'
  ) {
    throw new Error('Context index authority is unverified')
  }
  assertConversationIndexRetention(db, manifest.evidenceIndex, proof.retention_owner)
  assertConversationAuthorityRevision(db, proof.authority_revision)
}
