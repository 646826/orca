import type { ConversationQueueView } from '../agent-session-wire/structured-conversation-source-queue'
import { createConversationPreparationControls } from './conversation-preparation-controls'
import { ConversationPreparationStaleError } from './conversation-preparation-stale'
import type Database from '../../sqlite/sync-database'
import type { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import type { ConversationContextEvidenceReader } from './conversation-context-authority'
import type {
  ConversationPreparationTrigger,
  ConversationSwitchPreparationService
} from '../agent-session-wire/structured-conversation-switch-runtime-contracts'
import { runJournalTransaction } from '../agent-session-journal/journal-transaction'
import {
  createConversationPreparationAuthority,
  type ConversationPreparationTarget
} from './conversation-preparation-authority'
import { readConversationPreparationRequest } from './conversation-preparation-request'
import { readConversationPreparationConsent } from './conversation-preparation-consent'
import { freezeConversationPreparationSources } from './conversation-preparation-sources'
import {
  createConversationPreparationRows,
  ConversationPreparationRowsRefusal
} from './conversation-preparation-rows'
import { compileConversationContextPages } from './conversation-context-paged'
import { conversationContextDigest } from './conversation-context-consent'
import { authorizeConversationManifestIndex } from './conversation-context-index-authority'
import { saveConversationManifest, readConversationManifest } from './conversation-context-coverage'
import { readConversationCoverageRevision } from './conversation-context-authority-revision'

const MAX_INLINE_BYTES = 1024 * 1024
const MAX_SOURCE_ROW_BYTES = 1024 * 1024
export function createConversationPreparationService(input: {
  db: Database.Database
  stateDirectory: string
  store: () => AgentSessionAttachmentStore | null
  readTarget: (sessionId: string) => ConversationPreparationTarget | null
  now: () => number
  getJournal?: (sessionId: string) => ConversationQueueView | null
  /** Host-verified model estimator; target budget must reserve the actual trigger, attachments and output. */
  fullEstimator?: (
    target: ConversationPreparationTarget,
    trigger: ConversationPreparationTrigger | null
  ) => { countTokens: (text: string) => number; confidence: 'exact' | 'upper-bound' } | null
}) {
  const { db } = input
  const authority = createConversationPreparationAuthority(
    db,
    input.readTarget,
    input.now,
    input.getJournal
  )
  const readCurrentPreview = (manifestId: string) => {
    try {
      return authority.readPreview(manifestId)
    } catch (error) {
      if (error instanceof ConversationPreparationStaleError) {
        return null
      }
      throw error
    }
  }
  const readEvidence = (
    database: Database.Database,
    manifest: Parameters<ConversationContextEvidenceReader>[1],
    allowDispatchedWorkspace: boolean
  ): ReturnType<ConversationContextEvidenceReader> => {
    const binding = db
      .prepare(
        'SELECT operation_key,request_digest FROM conversation_preparation_request_previews WHERE manifest_id=?'
      )
      .get(manifest.manifestId)
    const request = binding && readConversationPreparationRequest(db, String(binding.operation_key))
    if (!request || conversationContextDigest(request) !== binding?.request_digest) {
      return null
    }
    return authority.readPreparationEvidence(database, manifest, allowDispatchedWorkspace)
  }
  const readPreparationEvidence: ConversationContextEvidenceReader = (database, manifest) =>
    readEvidence(database, manifest, true)
  const readPreDispatchPreparationEvidence: ConversationContextEvidenceReader = (
    database,
    manifest
  ) => readEvidence(database, manifest, false)
  const preparation: ConversationSwitchPreparationService = {
    async prepare(intent, previousManifestId, signal, trigger) {
      try {
        signal.throwIfAborted()
        const request = readConversationPreparationRequest(db, intent.operationKey)
        if (!request) {
          return { kind: 'blocked', reasons: ['recipient-approval-required'] }
        }
        const target = input.readTarget(intent.targetSessionId)
        if (
          !target ||
          request.expectedContextGeneration !== intent.contextGeneration ||
          request.targetSessionId !== target.target.sessionId ||
          request.targetBindingDigest !== conversationContextDigest(target.target) ||
          request.capabilityFingerprint !== target.target.capabilityFingerprint
        ) {
          return { kind: 'blocked', reasons: ['recipient-approval-stale'] }
        }
        if (request.policy === 'fresh') {
          return { kind: 'blocked', reasons: ['fresh-native-proof-required'] }
        }
        if (
          request.policy === 'full' &&
          (!target.budget ||
            target.budget.capacity === null ||
            target.budget.occupied === null ||
            target.budget.confidence === 'unknown')
        ) {
          return { kind: 'blocked', reasons: ['unknown-budget'] }
        }
        const estimator = input.fullEstimator?.(target, trigger)
        if (request.policy === 'full' && !estimator) {
          return { kind: 'blocked', reasons: ['unverified-budget-estimator'] }
        }
        const prior =
          previousManifestId ??
          db
            .prepare(
              'SELECT manifest_id FROM conversation_preparation_previews WHERE operation_key=? ORDER BY rowid DESC LIMIT 1'
            )
            .get(intent.operationKey)?.manifest_id
        let preview = typeof prior === 'string' ? readCurrentPreview(prior) : null
        if (
          preview &&
          (preview.manifest.policy !== request.policy ||
            conversationContextDigest(preview.trigger) !== conversationContextDigest(trigger) ||
            !readPreparationEvidence(db, preview.manifest) ||
            preview.sources.operationKey !== intent.operationKey)
        ) {
          preview = null
        }
        if (!preview) {
          const store = input.store()
          if (!store) {
            return { kind: 'blocked', reasons: ['attachment-store-unavailable'] }
          }
          const sources = await freezeConversationPreparationSources(db, intent, signal)
          const coverage =
            request.policy === 'budgeted'
              ? {
                  revision: readConversationCoverageRevision(db),
                  nativeIdentityDigest: target.nativeIdentityDigest
                }
              : undefined
          const result = await compileConversationContextPages({
            db,
            conversationId: intent.conversationId,
            contextGeneration: intent.contextGeneration,
            sourceRevision: sources.sourceRevision,
            target: target.target,
            policy: request.policy,
            budget: target.budget,
            mandatory: [],
            countTokens: estimator?.countTokens ?? null,
            inputTokenConfidence: estimator?.confidence ?? 'unknown',
            coverage,
            signal,
            now: input.now(),
            maxInlineBytes: MAX_INLINE_BYTES,
            expected: sources.enumeration,
            ...createConversationPreparationRows({
              projection:
                request.policy === 'budgeted' && target.target.retrieval === 'verified'
                  ? 'tools'
                  : 'exact',
              ...input,
              store,
              conversationId: intent.conversationId,
              snapshot: sources,
              targetBindingDigest: request.targetBindingDigest,
              maxBytes: MAX_SOURCE_ROW_BYTES,
              signal
            })
          })
          if (result.kind !== 'compiled') {
            return { kind: 'blocked', reasons: [result.reason] }
          }
          runJournalTransaction(db, () => {
            authority.publish({
              manifest: result.manifest,
              sourceOwnerId: sources.ownerId,
              target,
              trigger,
              coverageRevision: coverage?.revision
            })
            db.prepare('INSERT INTO conversation_preparation_request_previews VALUES(?,?,?)').run(
              result.manifest.manifestId,
              intent.operationKey,
              conversationContextDigest(request)
            )
          })
          preview = authority.readPreview(result.manifest.manifestId)
        }
        if (!preview) {
          throw new Error('Preparation publication missing')
        }
        const consent = readConversationPreparationConsent(db, preview.manifest.manifestId)
        if (preview.manifest.policy === 'budgeted' && !consent) {
          return { kind: 'waiting-consent' }
        }
        if (preview.manifest.evidenceIndex) {
          await authorizeConversationManifestIndex(
            db,
            preview.manifest,
            readPreparationEvidence,
            signal
          )
        }
        runJournalTransaction(db, () =>
          saveConversationManifest(db, preview.manifest, consent, readPreparationEvidence)
        )
        return {
          kind: 'prepared',
          plan: {
            manifestId: preview.manifest.manifestId,
            delivery: 'first-turn',
            sourceBoundaries: preview.sources.boundaries
          }
        }
      } catch (error) {
        if (error instanceof ConversationPreparationRowsRefusal) {
          return { kind: 'blocked', reasons: [error.message] }
        }
        throw error
      }
    },
    readPlan(manifestId) {
      const manifest = readConversationManifest(db, manifestId)
      const preview = readCurrentPreview(manifestId)
      if (!manifest || !preview || !readPreparationEvidence(db, manifest)) {
        return null
      }
      return { manifestId, delivery: 'first-turn', sourceBoundaries: preview.sources.boundaries }
    },
    verifyTrigger(manifestId, trigger) {
      const preview = readCurrentPreview(manifestId)
      if (!preview || !readPreparationEvidence(db, preview.manifest)) {
        throw new Error('Preparation request changed')
      }
      authority.verifyTrigger(manifestId, trigger)
    }
  }
  return {
    preparation,
    controls: createConversationPreparationControls({
      db,
      readTarget: input.readTarget,
      authority,
      readEvidence: readPreparationEvidence
    }),
    readPreparationEvidence,
    readPreDispatchPreparationEvidence,
    canRetrieve: () => false,
    authority
  }
}
