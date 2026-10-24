import { verifyConversationTransportProjection } from './conversation-transport-projection'
import { readConversationSourceSegmentId } from './conversation-source-attribution'
import type Database from '../../sqlite/sync-database'
import { createHash } from 'node:crypto'
import type {
  ConversationContextManifest,
  ConversationEvidenceIndex,
  ConversationContextRepresentation
} from '../../../shared/conversation-handoff'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { conversationContextDigest } from './conversation-context-consent'
import {
  readConversation,
  readParticipant,
  readSegments,
  readConversationDeliverySources
} from './conversation-read-model'
import { authorizeConversationSourceAtoms } from './conversation-source-atoms'
import { readConversationExportProof } from './conversation-context-export-proof'
import { readConversationExportDisclosure } from './conversation-source-disclosure'
import { conversationEvidenceKey } from './conversation-context-evidence'

export type ConversationContextPreparationEvidence = {
  proofId: string
  manifestDigest: string
  targetBindingDigest: string
  capabilityFingerprint: string
  contextGeneration: number
  sourceRevision: string
  budgetDigest: string
  nativeIdentityDigest?: string
  coverageRevision?: number
  artifactOwners?: readonly string[]
  evidenceIndex?: ConversationEvidenceIndex
  /** Independently enumerated by the host from all frozen canonical participants, never an RPC value. */
  sourceEnumeration?: { sourceCount: number; orderedVersionDigest: string }
}
export type ConversationContextEvidenceReader = (
  db: Database.Database,
  manifest: ConversationContextManifest
) => ConversationContextPreparationEvidence | null
export function verifyConversationContextEvidence(
  db: Database.Database,
  manifest: ConversationContextManifest,
  readEvidence: ConversationContextEvidenceReader
): ConversationContextPreparationEvidence {
  const proof = readEvidence(db, manifest)
  if (manifest.evidenceIndex) {
    const compilation = db
      .prepare(
        'SELECT source_count,ordered_source_digest FROM conversation_manifest_compilations WHERE index_id=? AND manifest_id=?'
      )
      .get(manifest.evidenceIndex.indexId, manifest.manifestId)
    if (
      !proof?.sourceEnumeration ||
      compilation?.source_count !== proof.sourceEnumeration.sourceCount ||
      compilation.ordered_source_digest !== proof.sourceEnumeration.orderedVersionDigest
    ) {
      throw new Error('Canonical source enumeration is unverified')
    }
  } else if (manifest.policy !== 'fresh') {
    const hash = createHash('sha256')
    for (const part of manifest.projection) {
      hash.update(conversationEvidenceKey(part.version)).update('\n')
    }
    if (
      !proof?.sourceEnumeration ||
      proof.sourceEnumeration.sourceCount !== manifest.projection.length ||
      proof.sourceEnumeration.orderedVersionDigest !== hash.digest('hex')
    ) {
      throw new Error('Canonical source enumeration is unverified')
    }
  }
  if (
    !proof ||
    !proof.proofId ||
    proof.manifestDigest !== manifest.digest ||
    proof.targetBindingDigest !== manifest.targetBindingDigest ||
    proof.capabilityFingerprint !== manifest.target.capabilityFingerprint ||
    proof.contextGeneration !== manifest.contextGeneration ||
    proof.sourceRevision !== manifest.sourceRevision ||
    proof.budgetDigest !== conversationContextDigest(manifest.budget) ||
    (manifest.evidenceIndex
      ? !proof.evidenceIndex ||
        conversationContextDigest(proof.evidenceIndex) !==
          conversationContextDigest(manifest.evidenceIndex)
      : manifest.projection.some(
          (part) =>
            part.artifactId !== undefined && !proof.artifactOwners?.includes(part.artifactId)
        ))
  ) {
    throw new Error('Context preparation is unverified')
  }
  return proof
}

export function conversationContextAccountDigest(
  identity: Pick<AgentSessionRecord, 'provider' | 'accountHome' | 'location'>
): string {
  return conversationContextDigest({
    provider: identity.provider,
    accountHome: identity.accountHome,
    location: identity.location
  })
}
export function conversationContextSourceRevision(
  db: Database.Database,
  conversationId: string,
  targetSessionId: string
): string {
  return conversationContextDigest(
    readConversationDeliverySources(db, conversationId, targetSessionId)
  )
}
export function assertConversationManifestAuthority(
  db: Database.Database,
  manifest: ConversationContextManifest
): void {
  const conversation = readConversation(db, manifest.conversationId)
  const target = readParticipant(db, manifest.target.sessionId)
  if (
    !conversation ||
    !target ||
    conversation.contextGeneration !== manifest.contextGeneration ||
    target.conversationId !== manifest.conversationId ||
    target.contextGeneration !== manifest.contextGeneration ||
    target.nativeBindingGeneration !== manifest.target.nativeBindingGeneration ||
    target.provider !== manifest.target.provider ||
    conversationContextAccountDigest(target) !== manifest.target.accountBindingDigest ||
    conversationContextSourceRevision(db, manifest.conversationId, target.sessionId) !==
      manifest.sourceRevision
  ) {
    throw new Error('Context manifest authority is stale')
  }
  const segments = sourceSegments(db, manifest)
  for (const part of manifest.projection) {
    assertPartAuthority(db, manifest, part, segments)
  }
}
export function assertConversationManifestPartAuthority(
  db: Database.Database,
  manifest: ConversationContextManifest,
  part: ConversationContextRepresentation
): void {
  assertPartAuthority(db, manifest, part, sourceSegments(db, manifest))
}
function sourceSegments(db: Database.Database, manifest: ConversationContextManifest) {
  return new Map(
    readSegments(db, manifest.conversationId).map((segment) => [segment.segmentId, segment])
  )
}
function assertPartAuthority(
  db: Database.Database,
  manifest: ConversationContextManifest,
  part: ConversationContextRepresentation,
  segments: ReturnType<typeof sourceSegments>
): void {
  const source = part.version.source
  if (
    part.representation === 'exact' &&
    (part.text === undefined ||
      createHash('sha256').update(part.text).digest('hex') !== part.version.sha256)
  ) {
    throw new Error('Exact context bytes are unverified')
  }
  if (
    part.representation === 'transport-projected'
      ? !verifyConversationTransportProjection(db, manifest, part)
      : part.transportProjection !== undefined
  ) {
    throw new Error('Transport projection authority is unverified')
  }
  const disclosure = part.artifactId
    ? readConversationExportDisclosure(db, {
        ownerId: part.artifactId,
        conversationId: manifest.conversationId,
        contextGeneration: manifest.contextGeneration,
        targetBindingDigest: manifest.targetBindingDigest,
        version: part.version
      })
    : null
  if (
    !disclosure ||
    (part.representation !== 'missing' && disclosure.action !== 'include') ||
    (disclosure.action === 'exclude' && disclosure.critical)
  ) {
    throw new Error('Context disclosure authority is unverified')
  }
  if (disclosure.action === 'exclude' && part.representation === 'missing') {
    const segmentId = readConversationSourceSegmentId(db, source)
    const segment = segmentId ? segments.get(segmentId) : undefined
    const retained = db
      .prepare(
        'SELECT 1 FROM journal_epoch_pins WHERE session_id=? AND epoch=? AND end_sequence>=? LIMIT 1'
      )
      .get(source.sessionId, source.epoch, source.sequence)
    if (
      !segment ||
      segment.contextGeneration !== manifest.contextGeneration ||
      segment.sessionId !== source.sessionId ||
      !retained ||
      source.itemId !== undefined ||
      source.itemRevision !== undefined ||
      source.batchIndex !== undefined
    ) {
      throw new Error('Excluded source scope is unverified')
    }
    return
  }
  const version = db
    .prepare(
      'SELECT sha256,row_kind,mutation_count FROM conversation_source_versions WHERE session_id=? AND epoch=? AND sequence=?'
    )
    .get(source.sessionId, source.epoch, source.sequence)
  if (
    version?.sha256 !== part.version.sha256 ||
    source.batchIndex !== undefined ||
    source.itemId !== undefined ||
    source.itemRevision !== undefined
  ) {
    throw new Error('Context source authority is unverified')
  }
  if (version.row_kind !== 'lifecycle-batch') {
    const segmentId = readConversationSourceSegmentId(db, source)
    const segment = segmentId ? segments.get(segmentId) : undefined
    if (
      !segment ||
      segment.sessionId !== source.sessionId ||
      segment.contextGeneration !== manifest.contextGeneration
    ) {
      throw new Error('Context source authority is unverified')
    }
  }
  if (
    version.row_kind === 'lifecycle-batch' &&
    (typeof version.mutation_count !== 'number' ||
      !authorizeConversationSourceAtoms(db, {
        conversationId: manifest.conversationId,
        contextGeneration: manifest.contextGeneration,
        source,
        sha256: part.version.sha256,
        mutationCount: version.mutation_count
      }))
  ) {
    throw new Error('Context batch authority is unverified')
  }
  if (
    part.representation !== 'missing' &&
    (!part.artifactId ||
      !readConversationExportProof(db, {
        ownerId: part.artifactId,
        conversationId: manifest.conversationId,
        contextGeneration: manifest.contextGeneration,
        version: part.version
      }))
  ) {
    throw new Error('Context artifact authority is unverified')
  }
}
