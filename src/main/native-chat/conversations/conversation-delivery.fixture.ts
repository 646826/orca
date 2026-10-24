import type { ConversationContextManifest } from '../../../shared/conversation-handoff'
import {
  consentForConversationManifest,
  conversationContextDigest
} from './conversation-context-consent'
import { pinQueuedMessageEvidence } from '../agent-session-journal/queued-message-origin'
import type { ConversationTriggerBinding } from './conversation-trigger-schema'
import { createConversationOriginRowHook } from './conversation-origin-rows'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { compileConversationContext } from './conversation-context-policy'
import {
  type ConversationContextPreparationEvidence,
  conversationContextAccountDigest,
  conversationContextSourceRevision
} from './conversation-context-authority'
import { saveConversationManifest, readConversationManifest } from './conversation-context-coverage'
import {
  prepareConversationDeliveryPlan,
  conversationDeliveryEnvelope,
  conversationDeliveryNativeIdentity,
  type ConversationDeliveryHost
} from './conversation-delivery-plan'
import { bindConversationNativeInput } from './conversation-delivery-receipt'
import { bindConversationOrigin } from './conversation-origin'

export async function createConversationDeliveryFixture(
  prepare?: (input: {
    fixture: Awaited<ReturnType<typeof createConversationSwitchFixture>>
    manifest: ConversationContextManifest
    signal: AbortSignal
  }) => Promise<{
    manifest: ConversationContextManifest
    evidence: Pick<
      ConversationContextPreparationEvidence,
      'sourceEnumeration' | 'artifactOwners' | 'evidenceIndex'
    >
  }>,
  sourceText?: string,
  beforeEnrollment?: Parameters<typeof createConversationSwitchFixture>[1]
) {
  const signal = new AbortController().signal

  const fixture = await createConversationSwitchFixture(sourceText, beforeEnrollment)
  const record = fixture.records.getRecord('session-b')
  const intent = fixture.records.conversations.intent(fixture.operationKey)
  if (!record || !intent || !intent.candidateSegmentId) {
    throw new Error('missing fixture')
  }
  const candidateSegmentId = intent.candidateSegmentId
  const native = {
    ...record,
    lease: {
      ...record.lease,
      claimStatus: 'live' as const,
      provenHandleLinkId: 'native-link',
      unreconciled: false,
      runtimeFence: 1
    },
    providerHandleChain: [
      {
        linkId: 'native-link',
        handle: { transport: 'codex-app-server', agent: 'codex', nativeId: 'native-thread' },
        origin: 'created' as const,
        mintedAtFence: 1,
        observedAt: 1
      }
    ]
  }
  const journal = new AgentSessionJournal({
    identity: {
      sessionId: record.sessionId,
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'codex',
      providerHandle: native.providerHandleChain[0].handle
    },
    database: fixture.host,
    requiredInTransaction: createConversationOriginRowHook(record.sessionId, () => ({
      conversationId: intent.conversationId,
      contextGeneration: 1,
      nativeBindingGeneration: 1
    }))
  })
  await journal.open()
  const sourceJournal = new AgentSessionJournal({
    identity: {
      sessionId: 'session-a',
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { transport: 'codex-app-server', agent: 'codex', nativeId: 'session-a' }
    },
    database: fixture.host
  })
  await sourceJournal.open()
  const compiled = compileConversationContext({
    conversationId: intent.conversationId,
    contextGeneration: 1,
    sourceRevision: conversationContextSourceRevision(
      fixture.host.db,
      intent.conversationId,
      record.sessionId
    ),
    target: {
      sessionId: record.sessionId,
      provider: 'codex',
      accountBindingDigest: conversationContextAccountDigest(record),
      nativeBindingGeneration: 1,
      capabilityFingerprint: 'caps',
      model: 'model',
      retrieval: 'unsupported'
    },
    policy: 'fresh',
    originals: [],
    projection: [],
    mandatory: [],
    budget: null,
    now: 1,
    signal,
    countTokens: () => 1
  })
  if (compiled.kind !== 'compiled') {
    throw new Error('fixture compilation failed')
  }
  const preparedContext = await prepare?.({ fixture, manifest: compiled.manifest, signal })
  let manifest = preparedContext?.manifest ?? compiled.manifest
  const authority: ConversationDeliveryHost = {
    getRecord: () => native,
    getJournal: (id) => (id === 'session-a' ? sourceJournal : id === 'session-b' ? journal : null),
    canRetrieve: () => preparedContext !== undefined,
    readPreparationEvidence: () => ({
      ...preparedContext?.evidence,
      proofId: 'host-proof',
      nativeIdentityDigest: conversationDeliveryNativeIdentity(authority, manifest)
        .nativeIdentityDigest,
      manifestDigest: manifest.digest,
      targetBindingDigest: manifest.targetBindingDigest,
      capabilityFingerprint: manifest.target.capabilityFingerprint,
      contextGeneration: 1,
      sourceRevision: manifest.sourceRevision,
      budgetDigest: conversationContextDigest(null)
    })
  }
  fixture.host.transaction((db) =>
    saveConversationManifest(
      db,
      manifest,
      manifest.policy === 'budgeted' ? consentForConversationManifest(manifest, 'fixture') : null,
      authority.readPreparationEvidence
    )
  )
  manifest = readConversationManifest(fixture.host.db, manifest.manifestId)!
  const prepared = await fixture.records.conversations.progress({
    operationKey: intent.operationKey,
    expectedVersion: intent.version,
    phase: 'prepared',
    sourceBoundaries: intent.sourceBoundaries,
    manifestId: manifest.manifestId,
    deliveryReceiptId: null
  })
  const plan = await prepareConversationDeliveryPlan(
    fixture.host.db,
    {
      operationKey: prepared.operationKey,
      expectedIntentVersion: prepared.version,
      manifestId: manifest.manifestId
    },
    authority,
    signal
  )
  await fixture.records.conversations.progress({
    operationKey: prepared.operationKey,
    expectedVersion: prepared.version,
    phase: 'delivering',
    sourceBoundaries: prepared.sourceBoundaries,
    manifestId: manifest.manifestId,
    deliveryReceiptId: null
  })
  fixture.host.transaction((db) =>
    bindConversationOrigin(db, {
      sessionId: record.sessionId,
      key: { kind: 'submission', id: 'trigger' },
      origin: {
        conversationId: intent.conversationId,
        segmentId: candidateSegmentId,
        contextGeneration: 1,
        nativeBindingGeneration: 1
      }
    })
  )
  await journal.appendSubmission({
    clientMessageId: 'trigger',
    payloadFingerprint: 'fp',
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: conversationDeliveryEnvelope(manifest, plan.inlineDeltaKeys) }]
    },
    fence: 1
  })
  const sourceCard = await sourceJournal.queuedMessages.insert({
    messageId: 'draft',
    body: { kind: 'message', role: 'user', blocks: [] }
  })
  fixture.host.transaction((db) =>
    pinQueuedMessageEvidence(db, {
      ownerId: 'conversation-transfer:transfer',
      sourceSessionId: 'session-a',
      messageId: 'draft',
      fingerprint: sourceCard.fingerprint,
      queueOrder: { position: sourceCard.position, queuedAt: sourceCard.queuedAt }
    })
  )
  await sourceJournal.queuedMessages.withdraw(['draft'])
  fixture.host.transaction((db) => {
    const binding: ConversationTriggerBinding = {
      transferId: 'transfer',
      kind: 'trigger',
      operationKey: intent.operationKey,
      conversationId: intent.conversationId,
      contextGeneration: 1,
      candidateGeneration: intent.activationFence,
      candidateSegmentId,
      nativeBindingGeneration: 1,
      queueSessionId: 'session-a',
      messageId: 'draft',
      sourceFingerprint: sourceCard.fingerprint,
      expectedQueueState: 'waiting',
      targetSessionId: 'session-b',
      targetSubmissionId: 'trigger',
      targetFingerprint: 'fp',
      targetOptionsDigest: 'options',
      deliveryPlanId: plan.planId,
      manifestId: manifest.manifestId,
      manifestDigest: manifest.digest,
      attachmentClaimsDigest: 'claims'
    }
    db.prepare('INSERT INTO conversation_trigger_reservations VALUES(?,?,?,?,?,?,?,?,?)').run(
      binding.transferId,
      binding.kind,
      binding.operationKey,
      binding.queueSessionId,
      binding.messageId,
      binding.targetSessionId,
      binding.targetSubmissionId,
      JSON.stringify(binding),
      'appended'
    )
  })

  function bind() {
    return bindConversationNativeInput(
      fixture.host.db,
      {
        planId: plan.planId,
        submissionId: 'trigger',
        observation: {
          transport: 'codex',
          payload: {
            threadId: 'native-thread',
            input: [
              { type: 'text', text: conversationDeliveryEnvelope(manifest, plan.inlineDeltaKeys) }
            ]
          }
        }
      },
      authority
    )
  }
  return { fixture, journal, sourceJournal, authority, manifest, plan, signal, bind }
}
