import { conversationRepresentationCoverageDigest } from './conversation-context-coverage-identity'
import type Database from '../../sqlite/sync-database'
import type {
  ConversationContextManifest,
  ConversationContextRepresentation
} from '../../../shared/conversation-handoff'
import { readConversationManifest } from './conversation-context-coverage'
import { conversationContextDigest } from './conversation-context-consent'
import { conversationEvidenceKey } from './conversation-context-policy'
import { readConversationManifestParts } from './conversation-context-parts'
import {
  assertConversationManifestAuthority,
  verifyConversationContextEvidence,
  type ConversationContextEvidenceReader
} from './conversation-context-authority'
import { assertConversationManifestIndexAuthorization } from './conversation-context-index-authority'
import { conversationRepresentationRequiresInline } from './conversation-context-constraints'

export type ConversationCoverageScope = Pick<
  ConversationContextManifest,
  'target' | 'targetBindingDigest' | 'contextGeneration'
> & { nativeIdentityDigest?: string }

export function hasConversationRepresentationCoverage(
  db: Database.Database,
  manifest: ConversationCoverageScope,
  part: ConversationContextRepresentation
): boolean {
  if (part.representation === 'missing' || !manifest.nativeIdentityDigest) {
    return false
  }
  const digest = conversationRepresentationCoverageDigest(part)
  if (
    db
      .prepare(
        `SELECT 1 FROM conversation_context_coverage c
        JOIN conversation_context_manifests m ON m.manifest_id=c.manifest_id
        WHERE c.target_session_id=? AND c.target_binding_digest=? AND c.context_generation=?
        AND c.native_binding_generation=? AND c.source_key=? AND c.representation_digest=?
        AND json_extract(m.preparation_evidence_json,'$.nativeIdentityDigest')=? LIMIT 1`
      )
      .get(
        manifest.target.sessionId,
        manifest.targetBindingDigest,
        manifest.contextGeneration,
        manifest.target.nativeBindingGeneration,
        conversationEvidenceKey(part.version),
        digest,
        manifest.nativeIdentityDigest
      )
  ) {
    return true
  }
  return Boolean(
    db
      .prepare(`SELECT 1 FROM conversation_manifest_parts p
    JOIN conversation_context_index_receipts r ON r.index_id=p.index_id
    JOIN conversation_manifest_part_indexes i ON i.index_id=r.index_id AND i.root_digest=r.root_digest AND i.part_count=r.part_count
    JOIN conversation_context_manifests m ON m.manifest_id=r.manifest_id
    WHERE p.source_key=? AND p.representation_digest=?
    AND json_extract(m.manifest_json,'$.target.sessionId')=?
    AND json_extract(m.manifest_json,'$.targetBindingDigest')=?
    AND json_extract(m.manifest_json,'$.contextGeneration')=?
    AND json_extract(m.manifest_json,'$.target.nativeBindingGeneration')=?
    AND json_extract(m.preparation_evidence_json,'$.nativeIdentityDigest')=? LIMIT 1`)
      .get(
        conversationContextDigest(part.version),
        digest,
        manifest.target.sessionId,
        manifest.targetBindingDigest,
        manifest.contextGeneration,
        manifest.target.nativeBindingGeneration,
        manifest.nativeIdentityDigest
      )
  )
}
/** Only context representations are skipped; this never replays or deduplicates user/tool effects. */
export function planConversationIndexedDeltaPage(
  db: Database.Database,
  input: {
    manifestId: string
    after: number
    limit: number
  },
  readEvidence: ConversationContextEvidenceReader = () => null,
  canRetrieve: (
    manifest: ConversationContextManifest,
    part: ConversationContextRepresentation
  ) => boolean = () => false
): {
  examinedThrough: number
  complete: boolean
  parts: { ordinal: number; part: ConversationContextRepresentation }[]
} {
  const manifest = readConversationManifest(db, input.manifestId)
  if (!manifest?.evidenceIndex) {
    throw new Error('Indexed context manifest is missing')
  }
  const evidence = verifyConversationContextEvidence(db, manifest, readEvidence)
  assertConversationManifestAuthority(db, manifest)
  assertConversationManifestIndexAuthorization(db, manifest)
  const page = readConversationManifestParts(
    db,
    manifest.evidenceIndex.indexId,
    input.after,
    input.limit
  )
  if (page.length === 0 && input.after < manifest.evidenceIndex.partCount) {
    throw new Error('Missing indexed representation')
  }
  const parts = page
    .filter(
      ({ part }) =>
        manifest.policy === 'full' ||
        conversationRepresentationRequiresInline(manifest, part) ||
        ((part.representation === 'retrievable-only' || part.representation === 'summarized') &&
          !canRetrieve(manifest, part)) ||
        !hasConversationRepresentationCoverage(
          db,
          { ...manifest, nativeIdentityDigest: evidence.nativeIdentityDigest },
          part
        )
    )
    .map(({ ordinal, part }) => ({ ordinal, part }))
  const examinedThrough = page.at(-1)?.ordinal ?? input.after
  return { examinedThrough, complete: examinedThrough >= manifest.evidenceIndex.partCount, parts }
}
