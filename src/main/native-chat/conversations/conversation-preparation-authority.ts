import type { ConversationQueueView } from '../agent-session-wire/structured-conversation-source-queue'
import { assertConversationPreparationTarget } from './conversation-preparation-target'
import { ConversationWorkspaceObservationSchema } from '../../../shared/conversation-workspace-observation'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type Database from '../../sqlite/sync-database'
import type { ConversationContextManifest } from '../../../shared/conversation-handoff'
import type { ConversationPreparationTrigger } from '../agent-session-wire/structured-conversation-switch-runtime-contracts'
import { conversationManifestSchema } from './conversation-context-schema'
import {
  conversationContextDigest,
  conversationManifestIntegrity
} from './conversation-context-consent'
import { readConversationPreparationSources } from './conversation-preparation-sources'
import {
  assertConversationManifestAuthority,
  type ConversationContextEvidenceReader
} from './conversation-context-authority'
import { readSwitchIntent, readConversation } from './conversation-read-model'
import { assertConversationPreparationTrigger } from './conversation-preparation-trigger'
import { assertConversationCoverageRevision } from './conversation-context-authority-revision'

const targetObservation = z.object({
  target: conversationManifestSchema.shape.target,
  budget: conversationManifestSchema.shape.budget,
  nativeIdentityDigest: z.string().min(1),
  runtimeFence: z.number().int().positive(),
  optionsDigest: z.string().min(1),
  freshNative: z.boolean(),
  workspaceObservation: ConversationWorkspaceObservationSchema.optional()
})
export type ConversationPreparationTarget = z.infer<typeof targetObservation>
const proofSchema = z.object({
  proofId: z.string().min(1),
  coverageRevision: z.number().int().nonnegative().optional()
})
const triggerSchema = z
  .object({
    queueSessionId: z.string().min(1),
    messageId: z.string().min(1),
    transferId: z.string().min(1),
    sourceFingerprint: z.string().min(1),
    attachmentClaimsDigest: z.string().min(1),
    targetOptionsDigest: z.string().min(1)
  })
  .nullable()

/** The live reader must derive options, capabilities and identity from the owning runtime. */
export function createConversationPreparationAuthority(
  db: Database.Database,
  readTarget: (sessionId: string) => ConversationPreparationTarget | null,
  now: () => number,
  getJournal: (sessionId: string) => ConversationQueueView | null = () => null
) {
  const currentTarget = (
    manifest: ConversationContextManifest,
    expected: ConversationPreparationTarget,
    allowDispatchedWorkspace = false,
    operationKey?: string
  ) =>
    assertConversationPreparationTarget(
      db,
      manifest,
      expected,
      readTarget(manifest.target.sessionId),
      now(),
      allowDispatchedWorkspace,
      operationKey
    )
  const readPreview = (manifestId: string) => {
    const row = db
      .prepare('SELECT * FROM conversation_preparation_previews WHERE manifest_id=?')
      .get(manifestId)
    if (!row) {
      return null
    }
    const manifest = conversationManifestSchema.parse(JSON.parse(String(row.manifest_json)))
    if (!conversationManifestIntegrity(manifest)) {
      throw new Error('Preparation preview corrupt')
    }
    const sources = readConversationPreparationSources(db, String(row.source_owner_id))
    if (
      !sources ||
      sources.operationKey !== row.operation_key ||
      sources.sourceRevision !== manifest.sourceRevision ||
      sources.contextGeneration !== manifest.contextGeneration
    ) {
      throw new Error('Preparation source proof missing')
    }
    return {
      manifest,
      sources,
      target: targetObservation.parse(JSON.parse(String(row.target_json))),
      trigger: triggerSchema.parse(JSON.parse(String(row.trigger_json))),
      proof: proofSchema.parse(JSON.parse(String(row.proof_json)))
    }
  }
  const readPreparationEvidence = (
    database: Database.Database,
    manifest: ConversationContextManifest,
    allowDispatchedWorkspace = true
  ): ReturnType<ConversationContextEvidenceReader> => {
    if (
      database !== db ||
      (manifest.policy === 'full' &&
        (manifest.inputTokens === null ||
          (manifest.inputTokenConfidence !== 'exact' &&
            manifest.inputTokenConfidence !== 'upper-bound')))
    ) {
      return null
    }
    try {
      const preview = readPreview(manifest.manifestId)
      if (
        !preview ||
        conversationContextDigest(preview.manifest) !== conversationContextDigest(manifest)
      ) {
        return null
      }
      currentTarget(
        manifest,
        preview.target,
        allowDispatchedWorkspace,
        preview.sources.operationKey
      )
      if (preview.trigger && preview.trigger.targetOptionsDigest !== preview.target.optionsDigest) {
        return null
      }
      assertConversationPreparationTrigger(
        db,
        preview.trigger,
        preview.sources.operationKey,
        getJournal
      )
      if (preview.proof.coverageRevision !== undefined) {
        assertConversationCoverageRevision(db, preview.proof.coverageRevision)
      }
      assertConversationManifestAuthority(db, manifest)
      return {
        proofId: preview.proof.proofId,
        nativeIdentityDigest: preview.target.nativeIdentityDigest,
        coverageRevision: preview.proof.coverageRevision,
        manifestDigest: manifest.digest,
        targetBindingDigest: manifest.targetBindingDigest,
        capabilityFingerprint: preview.target.target.capabilityFingerprint,
        contextGeneration: preview.sources.contextGeneration,
        sourceRevision: preview.sources.sourceRevision,
        budgetDigest: conversationContextDigest(preview.target.budget),
        sourceEnumeration: preview.sources.enumeration,
        artifactOwners: manifest.projection.flatMap((part) =>
          part.artifactId ? [part.artifactId] : []
        ),
        ...(manifest.evidenceIndex ? { evidenceIndex: manifest.evidenceIndex } : {})
      }
    } catch {
      return null
    }
  }
  const publish = (input: {
    manifest: ConversationContextManifest
    sourceOwnerId: string
    target: ConversationPreparationTarget
    trigger: ConversationPreparationTrigger | null
    coverageRevision?: number
  }) => {
    if (!db.isTransaction) {
      throw new Error('Preparation publication requires transaction')
    }
    const { manifest } = input
    if (
      manifest.policy === 'full' &&
      (manifest.inputTokens === null ||
        (manifest.inputTokenConfidence !== 'exact' &&
          manifest.inputTokenConfidence !== 'upper-bound'))
    ) {
      throw new Error('Full preparation requires a verified input estimate')
    }
    const sources = readConversationPreparationSources(db, input.sourceOwnerId)
    const intent = sources && readSwitchIntent(db, sources.operationKey)
    if (
      !sources ||
      !intent ||
      intent.version !== sources.intentVersion ||
      readConversation(db, intent.conversationId)?.pendingOperationKey !== intent.operationKey ||
      sources.sourceRevision !== manifest.sourceRevision ||
      sources.contextGeneration !== manifest.contextGeneration ||
      intent.targetSessionId !== manifest.target.sessionId ||
      !conversationManifestIntegrity(manifest)
    ) {
      throw new Error('Preparation source changed')
    }
    currentTarget(manifest, targetObservation.parse(input.target))
    if (input.trigger && input.trigger.targetOptionsDigest !== input.target.optionsDigest) {
      throw new Error('Preparation target options changed')
    }
    assertConversationPreparationTrigger(db, input.trigger, sources.operationKey, getJournal)
    if (input.coverageRevision !== undefined) {
      assertConversationCoverageRevision(db, input.coverageRevision)
    }
    assertConversationManifestAuthority(db, manifest)
    const serialized = JSON.stringify(manifest)
    const existing = readPreview(manifest.manifestId)
    if (existing) {
      if (
        conversationContextDigest(existing.manifest) !== conversationContextDigest(manifest) ||
        conversationContextDigest(existing.target) !== conversationContextDigest(input.target) ||
        conversationContextDigest(existing.trigger) !== conversationContextDigest(input.trigger)
      ) {
        throw new Error('Preparation preview conflict')
      }
      return
    }
    db.prepare('INSERT INTO conversation_preparation_previews VALUES(?,?,?,?,?,?,?)').run(
      manifest.manifestId,
      sources.operationKey,
      sources.ownerId,
      serialized,
      JSON.stringify(input.target),
      JSON.stringify(triggerSchema.parse(input.trigger)),
      JSON.stringify({ proofId: randomUUID(), coverageRevision: input.coverageRevision })
    )
  }
  const verifyTrigger = (manifestId: string, trigger: ConversationPreparationTrigger) => {
    const preview = readPreview(manifestId)
    if (
      !preview ||
      !readPreparationEvidence(db, preview.manifest) ||
      conversationContextDigest(preview.trigger) !== conversationContextDigest(trigger)
    ) {
      throw new Error('Preparation trigger changed')
    }
  }
  return { publish, readPreview, readPreparationEvidence, verifyTrigger }
}
