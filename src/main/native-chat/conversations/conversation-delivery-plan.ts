import { refreshVerifiedConversationManifestIndex } from './conversation-delivery-reauthorization'
import { randomUUID, createHash } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  ConversationContextManifest,
  ConversationContextRepresentation
} from '../../../shared/conversation-handoff'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import { runJournalTransaction } from '../agent-session-journal/journal-transaction'
import { readSwitchIntent, readConversation } from './conversation-read-model'
import {
  conversationContextAccountDigest,
  verifyConversationContextEvidence,
  assertConversationManifestAuthority,
  type ConversationContextEvidenceReader
} from './conversation-context-authority'
import { readConversationManifest } from './conversation-context-coverage'
import {
  planConversationIndexedDeltaPage,
  hasConversationRepresentationCoverage
} from './conversation-context-index-delta'
import { readConversationManifestParts } from './conversation-context-parts'
import { conversationContextDigest } from './conversation-context-consent'
import { conversationRepresentationCoverageDigest } from './conversation-context-coverage-identity'
import {
  readConversationCoverageRevision,
  assertConversationCoverageRevision,
  readConversationAuthorityRevision,
  assertConversationAuthorityRevision
} from './conversation-context-authority-revision'
import {
  conversationDeliveryPlanSchema,
  type ConversationDeliveryPlan
} from './conversation-delivery-schema'
import type { ConversationNativeTransport } from './conversation-delivery-transport'
export { conversationContextEnvelope as conversationDeliveryEnvelope } from './conversation-context-envelope'
import { conversationContextEnvelope as conversationDeliveryEnvelope } from './conversation-context-envelope'
import { conversationRepresentationRequiresInline } from './conversation-context-constraints'

export type ConversationDeliveryHost = {
  getRecord(sessionId: string): AgentSessionRecord | null
  getJournal(sessionId: string): AgentSessionJournal | null
  readPreparationEvidence: ConversationContextEvidenceReader
  readPreDispatchPreparationEvidence?: ConversationContextEvidenceReader
  canRetrieve(
    manifest: ConversationContextManifest,
    part: ConversationContextRepresentation
  ): boolean
}
export function conversationDeliveryNativeIdentity(
  host: ConversationDeliveryHost,
  manifest: ConversationContextManifest
) {
  const record = host.getRecord(manifest.target.sessionId)
  const head = record && agentSessionProviderHandleChainHead(record.providerHandleChain)
  if (
    !record ||
    !head ||
    record.provider !== manifest.target.provider ||
    record.lease.unreconciled ||
    record.lease.claimStatus !== 'live' ||
    record.lease.provenHandleLinkId !== head.linkId ||
    head.handle.agent !== record.provider ||
    conversationContextAccountDigest(record) !== manifest.target.accountBindingDigest
  ) {
    throw new Error('Native delivery identity is unverified')
  }
  const transport: ConversationNativeTransport =
    head.handle.transport === 'codex-app-server'
      ? 'codex'
      : head.handle.transport === 'claude-sdk'
        ? 'claude'
        : head.handle.transport === 'acp'
          ? 'acp'
          : (() => {
              throw new Error('Unsupported native delivery transport')
            })()
  return {
    nativeIdentityDigest: conversationContextDigest({
      head,
      account: manifest.target.accountBindingDigest
    }),
    runtimeFence: record.lease.runtimeFence,
    nativeSessionId: head.handle.nativeId,
    transport
  }
}
export function readConversationDeliveryPlan(
  db: Database.Database,
  planId: string
): ConversationDeliveryPlan | null {
  const row = db
    .prepare('SELECT plan_json FROM conversation_delivery_plans WHERE plan_id=?')
    .get(planId)
  return row ? conversationDeliveryPlanSchema.parse(JSON.parse(String(row.plan_json))) : null
}
export async function inspectConversationDeliveryAssignments(
  db: Database.Database,
  manifest: ConversationContextManifest,
  host: ConversationDeliveryHost,
  signal: AbortSignal
) {
  const evidence = verifyConversationContextEvidence(db, manifest, host.readPreparationEvidence)
  assertConversationManifestAuthority(db, manifest)
  const hash = createHash('sha256')
  const inline = new Set(manifest.projection.map(conversationRepresentationCoverageDigest))
  const inlineDeltaKeys: string[] = []
  let partCount = 0
  let acceptedPriorCount = 0
  let retrievalCount = 0
  const add = (part: ConversationContextRepresentation, required: boolean) => {
    const key = conversationRepresentationCoverageDigest(part)
    const retrieval =
      part.representation === 'retrievable-only' || part.representation === 'summarized'
    if (retrieval && !host.canRetrieve(manifest, part)) {
      throw new Error('Target retrieval is unavailable')
    }
    if (retrieval) {
      retrievalCount++
    }
    const role =
      part.representation === 'missing'
        ? 'omitted'
        : !required
          ? 'prior'
          : part.representation === 'retrievable-only'
            ? 'retrieval'
            : 'inline'
    if (role === 'prior') {
      acceptedPriorCount++
    }
    if (role === 'inline') {
      if (!inline.has(key)) {
        throw new Error('Required context is absent from the inline envelope')
      }
      inlineDeltaKeys.push(key)
    }
    hash.update(JSON.stringify([key, role])).update('\n')
    partCount++
  }
  if (manifest.evidenceIndex) {
    let after = 0
    while (after < manifest.evidenceIndex.partCount) {
      signal.throwIfAborted()
      const page = readConversationManifestParts(db, manifest.evidenceIndex.indexId, after, 128)
      const delta = planConversationIndexedDeltaPage(
        db,
        { manifestId: manifest.manifestId, after, limit: 128 },
        host.readPreparationEvidence,
        host.canRetrieve
      )
      const required = new Set(delta.parts.map((entry) => entry.ordinal))
      for (const entry of page) {
        add(entry.part, required.has(entry.ordinal))
      }
      after = delta.examinedThrough
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  } else {
    for (const part of manifest.projection) {
      add(
        part,
        manifest.policy === 'full' ||
          conversationRepresentationRequiresInline(manifest, part) ||
          !hasConversationRepresentationCoverage(
            db,
            { ...manifest, nativeIdentityDigest: evidence.nativeIdentityDigest },
            part
          )
      )
    }
  }
  return {
    assignmentDigest: hash.digest('hex'),
    inlineDeltaKeys,
    partCount,
    acceptedPriorCount,
    retrievalCount
  }
}

export async function prepareConversationDeliveryPlan(
  db: Database.Database,
  input: { operationKey: string; manifestId: string; expectedIntentVersion: number },
  host: ConversationDeliveryHost,
  signal: AbortSignal
): Promise<ConversationDeliveryPlan> {
  if (db.isTransaction) {
    throw new Error('Delivery preparation cannot run under a writer transaction')
  }
  await refreshVerifiedConversationManifestIndex(
    db,
    input.manifestId,
    host.readPreparationEvidence,
    signal
  )
  const intent = readSwitchIntent(db, input.operationKey)
  const manifest = readConversationManifest(db, input.manifestId)
  if (
    !intent ||
    intent.phase !== 'prepared' ||
    readConversation(db, intent.conversationId)?.pendingOperationKey !== intent.operationKey ||
    !manifest ||
    intent.version !== input.expectedIntentVersion ||
    intent.manifestId !== manifest.manifestId ||
    intent.targetSessionId !== manifest.target.sessionId ||
    intent.contextGeneration !== manifest.contextGeneration ||
    intent.nativeBindingGeneration !== manifest.target.nativeBindingGeneration ||
    !intent.candidateSegmentId
  ) {
    throw new Error('Delivery intent is stale')
  }
  const authorityRevision = readConversationAuthorityRevision(db)
  const coverageRevision = readConversationCoverageRevision(db)
  const native = conversationDeliveryNativeIdentity(host, manifest)
  const assignments = await inspectConversationDeliveryAssignments(db, manifest, host, signal)
  const envelope = conversationDeliveryEnvelope(manifest, assignments.inlineDeltaKeys)
  const evidence = verifyConversationContextEvidence(db, manifest, host.readPreparationEvidence)
  if (
    evidence.coverageRevision !== undefined &&
    envelope !== conversationDeliveryEnvelope(manifest)
  ) {
    throw new Error('Approved context projection changed')
  }
  const envelopeDigest = createHash('sha256').update(envelope).digest('hex')
  const plan = conversationDeliveryPlanSchema.parse({
    planId: randomUUID(),
    operationKey: intent.operationKey,
    intentVersion: intent.version,
    manifestId: manifest.manifestId,
    manifestDigest: manifest.digest,
    targetSessionId: intent.targetSessionId,
    contextGeneration: intent.contextGeneration,
    nativeBindingGeneration: intent.nativeBindingGeneration,
    ...native,
    ...assignments,
    envelopeDigest
  })
  signal.throwIfAborted()
  runJournalTransaction(db, () => {
    assertConversationAuthorityRevision(db, authorityRevision)
    assertConversationCoverageRevision(db, coverageRevision)
    verifyConversationContextEvidence(db, manifest, host.readPreparationEvidence)
    if (
      readSwitchIntent(db, intent.operationKey)?.version !== intent.version ||
      conversationContextDigest(conversationDeliveryNativeIdentity(host, manifest)) !==
        conversationContextDigest(native)
    ) {
      throw new Error('Delivery preparation changed')
    }
    db.prepare('INSERT INTO conversation_delivery_plans VALUES(?,?,?,?)').run(
      plan.planId,
      plan.operationKey,
      plan.manifestId,
      JSON.stringify(plan)
    )
  })
  return plan
}
