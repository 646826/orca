import { conversationRepresentationCoverageDigest } from './conversation-context-coverage-identity'
import { readSwitchIntent } from './conversation-read-model'
import { assertConversationManifestIndexAuthorization } from './conversation-context-index-authority'
import {
  recordConversationIndexReceipt,
  readConversationIndexCoveragePage
} from './conversation-context-index-coverage'
import type Database from '../../sqlite/sync-database'
import {
  assertConversationManifestAuthority,
  verifyConversationContextEvidence,
  type ConversationContextEvidenceReader
} from './conversation-context-authority'
import type {
  ConversationContextManifest,
  ConversationContextRepresentation,
  ConversationCoverageEntry,
  ConversationProjectionConsent
} from '../../../shared/conversation-handoff'
import type { ConversationDeliveryEvidenceReader } from './conversation-store'
import { pinJournalEpoch } from '../agent-session-journal/journal-epoch-pins'
import { conversationEvidenceKey } from './conversation-context-policy'
import {
  conversationManifestIntegrity,
  validateConversationConsent
} from './conversation-context-consent'
import {
  conversationManifestSchema,
  conversationCoverageSchema
} from './conversation-context-schema'

function transaction(db: Database.Database): void {
  if (!db.isTransaction) {
    throw new Error('Context persistence requires a host transaction')
  }
}
export function saveConversationManifest(
  db: Database.Database,
  manifest: ConversationContextManifest,
  consent: ConversationProjectionConsent | null,
  readEvidence: ConversationContextEvidenceReader = () => null
): void {
  transaction(db)
  if (manifest.evidenceIndex) {
    assertConversationManifestIndexAuthorization(db, manifest)
  }
  const evidence = verifyConversationContextEvidence(db, manifest, readEvidence)
  assertConversationManifestAuthority(db, manifest)
  if (
    !conversationManifestSchema.safeParse(manifest).success ||
    !validateConversationConsent(manifest, consent)
  ) {
    throw new Error('Context manifest or consent is invalid')
  }
  const serialized = JSON.stringify(manifest)
  const approval = consent === null ? null : JSON.stringify(consent)
  const existing = db
    .prepare(
      'SELECT manifest_json,consent_json FROM conversation_context_manifests WHERE manifest_id=?'
    )
    .get(manifest.manifestId)
  if (existing) {
    if (existing.manifest_json !== serialized || existing.consent_json !== approval) {
      throw new Error('Context manifest is immutable')
    }
    return
  }
  const boundaries = new Map<string, { sessionId: string; epoch: string; endSequence: number }>()
  for (const part of manifest.projection) {
    const source = part.version.source
    const key = JSON.stringify([source.sessionId, source.epoch])
    const before = boundaries.get(key)
    boundaries.set(key, {
      sessionId: source.sessionId,
      epoch: source.epoch,
      endSequence: Math.max(before?.endSequence ?? 0, source.sequence)
    })
  }
  for (const boundary of boundaries.values()) {
    pinJournalEpoch(db, { ownerId: `conversation-manifest:${manifest.manifestId}`, ...boundary })
  }
  db.prepare(
    'INSERT INTO conversation_context_manifests(manifest_id,manifest_json,consent_json,preparation_evidence_json) VALUES(?,?,?,?)'
  ).run(manifest.manifestId, serialized, approval, JSON.stringify(evidence))
}
export function readConversationManifest(
  db: Database.Database,
  id: string
): ConversationContextManifest | null {
  const row = db
    .prepare('SELECT manifest_json FROM conversation_context_manifests WHERE manifest_id=?')
    .get(id)
  if (!row) {
    return null
  }
  if (typeof row.manifest_json !== 'string') {
    throw new Error('Context manifest is corrupt')
  }
  const parsed = conversationManifestSchema.safeParse(JSON.parse(row.manifest_json))
  if (!parsed.success || !conversationManifestIntegrity(parsed.data)) {
    throw new Error('Context manifest is corrupt')
  }
  return parsed.data
}
export function recordConversationCoverage(
  db: Database.Database,
  manifestId: string,
  receiptId: string,
  readEvidence: ConversationDeliveryEvidenceReader,
  readPreparationEvidence: ConversationContextEvidenceReader = () => null
): void {
  transaction(db)
  const manifest = readConversationManifest(db, manifestId)
  const evidence = readEvidence(db, receiptId)
  const intent = evidence ? readSwitchIntent(db, evidence.operationKey) : null
  if (
    !manifest ||
    !evidence ||
    !intent ||
    intent.operationKey !== evidence.operationKey ||
    intent.activationFence !== evidence.activationFence ||
    intent.conversationId !== manifest.conversationId ||
    intent.targetSessionId !== evidence.targetSessionId ||
    intent.contextGeneration !== evidence.contextGeneration ||
    intent.nativeBindingGeneration !== evidence.nativeBindingGeneration ||
    evidence.deliveryReceiptId !== receiptId ||
    evidence.manifestId !== manifestId ||
    evidence.targetSessionId !== manifest.target.sessionId ||
    evidence.contextGeneration !== manifest.contextGeneration ||
    evidence.nativeBindingGeneration !== manifest.target.nativeBindingGeneration
  ) {
    throw new Error('Context delivery is unverified')
  }
  verifyConversationContextEvidence(db, manifest, readPreparationEvidence)
  assertConversationManifestAuthority(db, manifest)
  if (manifest.evidenceIndex) {
    assertConversationManifestIndexAuthorization(db, manifest)
    recordConversationIndexReceipt(db, manifest, receiptId)
    return
  }
  for (const part of manifest.projection) {
    const entry: ConversationCoverageEntry = {
      manifestId,
      receiptId,
      targetSessionId: manifest.target.sessionId,
      targetBindingDigest: manifest.targetBindingDigest,
      contextGeneration: manifest.contextGeneration,
      nativeBindingGeneration: manifest.target.nativeBindingGeneration,
      version: part.version,
      representation: part.representation,
      representationDigest: conversationRepresentationCoverageDigest(part)
    }
    db.prepare(
      `INSERT INTO conversation_context_coverage(target_session_id,target_binding_digest,context_generation,native_binding_generation,source_key,representation_digest,manifest_id,record_json) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`
    ).run(
      entry.targetSessionId,
      entry.targetBindingDigest,
      entry.contextGeneration,
      entry.nativeBindingGeneration,
      conversationEvidenceKey(entry.version),
      entry.representationDigest,
      manifestId,
      JSON.stringify(entry)
    )
  }
}
export function readConversationCoverage(
  db: Database.Database,
  targetSessionId: string,
  contextGeneration: number,
  nativeBindingGeneration: number
): ConversationCoverageEntry[] {
  return db
    .prepare(
      'SELECT record_json FROM conversation_context_coverage WHERE target_session_id=? AND context_generation=? AND native_binding_generation=? ORDER BY source_key,representation_digest'
    )
    .all(targetSessionId, contextGeneration, nativeBindingGeneration)
    .map((row) => {
      if (typeof row.record_json !== 'string') {
        throw new Error('Context coverage is corrupt')
      }
      const parsed = conversationCoverageSchema.safeParse(JSON.parse(row.record_json))
      if (!parsed.success) {
        throw new Error('Context coverage is corrupt')
      }
      return parsed.data
    })
}
export function planConversationDelta(
  manifest: ConversationContextManifest,
  coverage: readonly ConversationCoverageEntry[],
  /** Host verifier must recheck artifact integrity, disclosure and current target access. */
  canRetrieve: (
    manifest: ConversationContextManifest,
    part: ConversationContextRepresentation
  ) => boolean = () => false
): ConversationContextRepresentation[] {
  if (manifest.evidenceIndex) {
    throw new Error('Indexed context requires paged delta planning')
  }
  const delivered = new Set(
    coverage
      .filter(
        (entry) =>
          entry.representation !== 'missing' &&
          entry.targetSessionId === manifest.target.sessionId &&
          entry.targetBindingDigest === manifest.targetBindingDigest &&
          entry.contextGeneration === manifest.contextGeneration &&
          entry.nativeBindingGeneration === manifest.target.nativeBindingGeneration
      )
      .map((entry) =>
        JSON.stringify([conversationEvidenceKey(entry.version), entry.representationDigest])
      )
  )
  return manifest.projection.filter(
    (part) =>
      ((part.representation === 'retrievable-only' || part.representation === 'summarized') &&
        !canRetrieve(manifest, part)) ||
      !delivered.has(
        JSON.stringify([
          conversationEvidenceKey(part.version),
          conversationRepresentationCoverageDigest(part)
        ])
      )
  )
}

/** Current target access and sealed-source authority are checked on every bounded page read. */
export function readConversationIndexedCoveragePage(
  db: Database.Database,
  input: {
    manifestId: string
    receiptId: string
    after: number
    limit: number
  },
  readEvidence: ConversationContextEvidenceReader = () => null
): { ordinal: number; entry: ConversationCoverageEntry }[] {
  const manifest = readConversationManifest(db, input.manifestId)
  if (!manifest?.evidenceIndex) {
    throw new Error('Indexed coverage manifest is missing')
  }
  verifyConversationContextEvidence(db, manifest, readEvidence)
  assertConversationManifestAuthority(db, manifest)
  assertConversationManifestIndexAuthorization(db, manifest)
  return readConversationIndexCoveragePage(db, manifest, input.receiptId, input.after, input.limit)
}
