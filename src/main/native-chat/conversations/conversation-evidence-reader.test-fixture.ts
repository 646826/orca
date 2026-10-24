import type { ConversationContextManifest } from '../../../shared/conversation-handoff'
import type { ConversationEvidenceHost } from './conversation-evidence-scope'
import { compileConversationContextPages } from './conversation-context-paged'
import { authorizeConversationManifestIndex } from './conversation-context-index-authority'
import type { ConversationContextEvidenceReader } from './conversation-context-authority'
import { createHash } from 'node:crypto'
import { createConversationDeliveryFixture } from './conversation-delivery.fixture'
import { exportConversationContext } from './conversation-context-export'
import { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import { readConversationSourceSegmentId } from './conversation-source-attribution'
import { compileConversationContext } from './conversation-context-policy'
import { conversationContextDigest } from './conversation-context-consent'
import { conversationEvidenceKey } from './conversation-context-evidence'

export async function createConversationEvidenceFixture(
  indexed = false,
  gapCount = 0,
  configureTarget?: (
    fixture: Parameters<
      NonNullable<Parameters<typeof createConversationDeliveryFixture>[0]>
    >[0]['fixture'],
    target: ConversationContextManifest['target']
  ) => ConversationContextManifest['target'],
  sourceSeed?: Parameters<typeof createConversationDeliveryFixture>[2]
) {
  let original = ''
  const f = await createConversationDeliveryFixture(
    async ({ fixture, manifest, signal }) => {
      const db = fixture.host.db
      const row = db
        .prepare(
          `SELECT seq,row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq>1 AND json_extract(row_json,'$.kind')!='queue' ORDER BY seq LIMIT 1`
        )
        .get('session-a', 'epoch-session-a')
      if (typeof row?.row_json !== 'string' || typeof row.seq !== 'number') {
        throw new Error('source missing')
      }
      const source = { sessionId: 'session-a', epoch: 'epoch-session-a', sequence: row.seq }
      original = row.row_json
      const gaps = Array.from({ length: gapCount }, () => ({
        source,
        reason: 'legacy-bounded' as const,
        critical: false
      }))
      const version = { source, sha256: createHash('sha256').update(original).digest('hex') }
      const pin = db
        .prepare('SELECT owner_id FROM journal_epoch_pins WHERE session_id=? AND epoch=? LIMIT 1')
        .get(source.sessionId, source.epoch)
      const segmentId = readConversationSourceSegmentId(db, source)
      if (typeof pin?.owner_id !== 'string' || !segmentId) {
        throw new Error('source scope missing')
      }
      const initialTarget = { ...manifest.target, retrieval: 'verified' as const }
      const target = configureTarget?.(fixture, initialTarget) ?? initialTarget
      const targetBindingDigest = conversationContextDigest(target)
      const exported = await exportConversationContext({
        db,
        stateDirectory: fixture.host.stateDirectory,
        store: new AgentSessionAttachmentStore(
          agentSessionAttachmentStoreRoot(fixture.host.stateDirectory),
          { hasSession: () => true }
        ),
        conversationId: manifest.conversationId,
        contextGeneration: 1,
        signal,
        sources: [
          { source, segmentId, pinOwnerId: pin.owner_id, decision: 'include', critical: false }
        ],
        disclosure: {
          targetBindingDigest,
          resolve: () => ({
            version,
            contextGeneration: 1,
            targetBindingDigest,
            action: 'include',
            reason: 'user-policy',
            critical: false
          })
        }
      })
      let compiled = compileConversationContext({
        conversationId: manifest.conversationId,
        contextGeneration: 1,
        sourceRevision: manifest.sourceRevision,
        target,
        policy: 'budgeted',
        originals: [{ version, text: original, kind: 'historical-data', gaps }],
        projection: [
          {
            version,
            representation: 'exact',
            text: original,
            spans: [],
            artifactId: exported.artifact.ownerId
          }
        ],
        mandatory: [],
        budget: null,
        now: 1,
        signal,
        countTokens: () => 1
      })
      if (compiled.kind !== 'compiled') {
        throw new Error(compiled.reason)
      }
      const sourceEnumeration = {
        sourceCount: 1,
        orderedVersionDigest: createHash('sha256')
          .update(`${conversationEvidenceKey(version)}\n`)
          .digest('hex')
      }
      if (indexed) {
        const small = compiled.manifest
        compiled = await compileConversationContextPages({
          db,
          conversationId: small.conversationId,
          contextGeneration: 1,
          sourceRevision: small.sourceRevision,
          target: small.target,
          policy: 'budgeted',
          mandatory: [],
          budget: null,
          now: 1,
          signal,
          countTokens: () => 1,
          maxInlineBytes: 65536,
          expected: sourceEnumeration,
          rows: (async function* () {
            yield {
              original: { version, text: original, kind: 'historical-data' as const, gaps: [] },
              representation: small.projection[0]!
            }
          })()
        })
        if (compiled.kind !== 'compiled') {
          throw new Error(compiled.reason)
        }
        const indexedManifest = compiled.manifest
        const read: ConversationContextEvidenceReader = () => ({
          proofId: 'reader-fixture',
          manifestDigest: indexedManifest.digest,
          targetBindingDigest: indexedManifest.targetBindingDigest,
          capabilityFingerprint: indexedManifest.target.capabilityFingerprint,
          contextGeneration: 1,
          sourceRevision: indexedManifest.sourceRevision,
          budgetDigest: conversationContextDigest(null),
          evidenceIndex: indexedManifest.evidenceIndex,
          sourceEnumeration
        })
        await authorizeConversationManifestIndex(db, indexedManifest, read, signal)
      }
      return {
        manifest: compiled.manifest,
        evidence: {
          artifactOwners: [exported.artifact.ownerId],
          evidenceIndex: compiled.manifest.evidenceIndex,
          sourceEnumeration
        }
      }
    },
    sourceSeed ? undefined : `${'甲🙂'.repeat(1000)} mandatory final constraint🙂`,
    sourceSeed
  )
  return {
    ...f,
    original,
    host: {
      ...f.authority,
      readAcquisition: (): ReturnType<ConversationEvidenceHost['readAcquisition']> => ({
        acquisitionGeneration: 'acquired',
        capabilityFingerprint: f.manifest.target.capabilityFingerprint
      })
    } satisfies ConversationEvidenceHost
  }
}
