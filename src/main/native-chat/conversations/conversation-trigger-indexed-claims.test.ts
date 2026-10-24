import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { triggerClaimsFixture } from './conversation-trigger-claims.test-fixture'
import { stageConversationTriggerClaims } from './conversation-trigger-claim-staging'
import { prepareConversationTrigger } from './conversation-trigger-claims'
import { prepareConversationDeliveryPlan } from './conversation-delivery-plan'
import { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import { exportConversationContext } from './conversation-context-export'
import { compileConversationContextPages } from './conversation-context-paged'
import { conversationEvidenceKey } from './conversation-context-policy'
import {
  conversationContextDigest,
  consentForConversationManifest
} from './conversation-context-consent'
import {
  authorizeConversationManifestIndex,
  assertConversationManifestIndexAuthorization
} from './conversation-context-index-authority'
import { saveConversationManifest } from './conversation-context-coverage'
import {
  conversationContextSourceRevision,
  type ConversationContextEvidenceReader
} from './conversation-context-authority'
import { readConversationSourceSegmentId } from './conversation-source-attribution'

it('stages a managed upload before authorizing a nonempty index and reserving its trigger', async () => {
  const f = await triggerClaimsFixture(async (_directory, storeFile) => {
    const path = await storeFile('evidence.txt', 'managed trigger evidence')
    return { kind: 'message', role: 'user', blocks: [{ type: 'text', text: path }] }
  })
  const signal = new AbortController().signal
  const staged = await stageConversationTriggerClaims(
    f.db,
    {
      ...f.request,
      expectedIntentVersion: f.intent.version,
      stateDirectory: f.claimsHost.stateDirectory
    },
    1,
    signal,
    f.deliveryHost.getJournal
  )
  const boundary = f.intent.sourceBoundaries[0]!
  const source = { sessionId: boundary.sessionId, epoch: boundary.epoch, sequence: 1 }
  const segmentId = readConversationSourceSegmentId(f.db, source)!
  const stored = f.db
    .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?')
    .get(source.sessionId, source.epoch, 1)
  if (typeof stored?.row_json !== 'string') {
    throw new Error('missing source')
  }
  const text = stored.row_json
  const version = { source, sha256: createHash('sha256').update(text).digest('hex') }
  const pin = f.db
    .prepare(
      'SELECT owner_id FROM journal_epoch_pins WHERE session_id=? AND epoch=? AND end_sequence>=1 LIMIT 1'
    )
    .get(source.sessionId, source.epoch)
  if (typeof pin?.owner_id !== 'string') {
    throw new Error('missing pin')
  }
  const exported = await exportConversationContext({
    db: f.db,
    stateDirectory: f.claimsHost.stateDirectory,
    store: new AgentSessionAttachmentStore(
      agentSessionAttachmentStoreRoot(f.claimsHost.stateDirectory),
      { hasSession: () => true }
    ),
    conversationId: f.intent.conversationId,
    contextGeneration: 1,
    signal,
    sources: [
      { source, segmentId, pinOwnerId: pin.owner_id, decision: 'include', critical: false }
    ],
    disclosure: {
      targetBindingDigest: f.manifest.targetBindingDigest,
      resolve: () => ({
        version,
        contextGeneration: 1,
        targetBindingDigest: f.manifest.targetBindingDigest,
        action: 'include',
        reason: 'user-policy',
        critical: false
      })
    }
  })
  const expected = {
    sourceCount: 1,
    orderedVersionDigest: createHash('sha256')
      .update(`${conversationEvidenceKey(version)}\n`)
      .digest('hex')
  }
  const compiled = await compileConversationContextPages({
    db: f.db,
    conversationId: f.intent.conversationId,
    contextGeneration: 1,
    sourceRevision: conversationContextSourceRevision(f.db, f.intent.conversationId, f.targetId),
    target: f.manifest.target,
    policy: 'budgeted',
    mandatory: [],
    budget: null,
    countTokens: () => 1,
    now: 1,
    signal,
    maxInlineBytes: 1024 * 1024,
    expected,
    rows: (async function* () {
      yield {
        original: { version, text, kind: 'historical-data' as const, gaps: [] },
        representation: {
          version,
          representation: 'exact' as const,
          text,
          spans: [],
          artifactId: exported.artifact.ownerId
        }
      }
    })()
  })
  if (compiled.kind !== 'compiled') {
    throw new Error(compiled.reason)
  }
  const manifest = compiled.manifest
  expect(manifest.evidenceIndex?.partCount).toBe(1)
  const read: ConversationContextEvidenceReader = (_db, requested) =>
    requested.digest === manifest.digest
      ? {
          proofId: 'indexed-staging-fixture',
          manifestDigest: manifest.digest,
          targetBindingDigest: manifest.targetBindingDigest,
          capabilityFingerprint: manifest.target.capabilityFingerprint,
          contextGeneration: 1,
          sourceRevision: manifest.sourceRevision,
          budgetDigest: conversationContextDigest(null),
          evidenceIndex: manifest.evidenceIndex,
          sourceEnumeration: expected
        }
      : null
  await authorizeConversationManifestIndex(f.db, manifest, read, signal)
  f.host.deps.journalDatabase.transaction((db) =>
    saveConversationManifest(db, manifest, consentForConversationManifest(manifest, 'user'), read)
  )
  const ready = await f.store.conversations.progress({
    operationKey: f.intent.operationKey,
    expectedVersion: f.intent.version,
    phase: 'prepared',
    sourceBoundaries: f.intent.sourceBoundaries,
    manifestId: manifest.manifestId,
    deliveryReceiptId: null
  })
  const deliveryHost = { ...f.deliveryHost, readPreparationEvidence: read }
  const plan = await prepareConversationDeliveryPlan(
    f.db,
    {
      operationKey: ready.operationKey,
      expectedIntentVersion: ready.version,
      manifestId: manifest.manifestId
    },
    deliveryHost,
    signal
  )
  expect(() => assertConversationManifestIndexAuthorization(f.db, manifest)).not.toThrow()
  const prepared = await prepareConversationTrigger(
    f.db,
    { ...f.request, deliveryPlanId: plan.planId },
    { ...f.claimsHost, readPreparationEvidence: read },
    1,
    signal
  )
  expect(prepared.binding.attachmentClaimsDigest).toBe(staged.attachmentClaimsDigest)
  expect(prepared.authority.verifyTriggerClaims(f.db, prepared.binding)).toBe(true)
})
