import { compareWorkspaceWatchObservation } from '../../../shared/conversation-workspace-observation'
import { readConversationPreparationEvidencePage } from './conversation-preparation-evidence'
import type { ConversationEvidenceTrustChoice } from './conversation-evidence-trust'
import { ConversationRpcRefusal } from '../../../shared/conversation-rpc-refusal'
import type { ConversationContextEvidenceReader } from './conversation-context-authority'
import type Database from '../../sqlite/sync-database'
import type {
  ConversationRecipientChoice,
  ConversationManifestChoice,
  ConversationPreparationEvidencePage,
  ConversationPreparationView
} from '../../../shared/conversation-rpc'
import type {
  createConversationPreparationAuthority,
  ConversationPreparationTarget
} from './conversation-preparation-authority'
import { readSwitchIntent, readConversation, readSegments } from './conversation-read-model'
import {
  readConversationPreparationRequest,
  approveConversationPreparationRequest
} from './conversation-preparation-request'
import {
  approveConversationPreparation,
  readConversationPreparationConsent
} from './conversation-preparation-consent'
import { ConversationPreparationStaleError } from './conversation-preparation-stale'
import { conversationContextDigest } from './conversation-context-consent'

export type ConversationEvidenceTrustControls = {
  read(operationKey: string): ConversationEvidenceTrustChoice | null
  approve(input: { operationKey: string; choiceDigest: string }, callerKey: string): void
}
export type ConversationPreparationControls = {
  read(operationKey: string): ConversationPreparationView | null
  evidence(input: {
    operationKey: string
    manifestDigest: string
    after: number
    limit: number
  }): ConversationPreparationEvidencePage
  approveRecipient(choice: ConversationRecipientChoice, callerKey: string): void
  approveManifest(choice: ConversationManifestChoice, callerKey: string): void
}
export function createConversationPreparationControls(input: {
  readEvidence: ConversationContextEvidenceReader
  db: Database.Database
  readTarget(sessionId: string): ConversationPreparationTarget | null
  authority: ReturnType<typeof createConversationPreparationAuthority>
}): ConversationPreparationControls {
  const { db, authority } = input
  const currentPreview = (digest: string) => {
    try {
      return authority.readPreview(digest)
    } catch (error) {
      if (error instanceof ConversationPreparationStaleError) {
        throw new ConversationRpcRefusal('stale-preview')
      }
      throw error
    }
  }
  return {
    evidence(request) {
      const preview = currentPreview(request.manifestDigest)
      if (
        !preview ||
        preview.sources.operationKey !== request.operationKey ||
        !input.readEvidence(db, preview.manifest)
      ) {
        throw new ConversationRpcRefusal('stale-preview')
      }
      const page = readConversationPreparationEvidencePage(
        db,
        preview.manifest,
        request.after,
        request.limit
      )
      if (!input.readEvidence(db, preview.manifest)) {
        throw new ConversationRpcRefusal('stale-preview')
      }
      return page
    },
    read(operationKey) {
      const intent = readSwitchIntent(db, operationKey)
      if (!intent) {
        return null
      }
      const conversation = readConversation(db, intent.conversationId)
      const observed = input.readTarget(intent.targetSessionId)
      const request = readConversationPreparationRequest(db, operationKey)
      const target = observed
        ? {
            sessionId: observed.target.sessionId,
            provider: observed.target.provider,
            model: observed.target.model,
            accountBindingDigest: observed.target.accountBindingDigest,
            capabilityFingerprint: observed.target.capabilityFingerprint,
            bindingDigest: conversationContextDigest(observed.target),
            budget:
              observed.budget?.capacity !== null &&
              observed.budget?.capacity !== undefined &&
              observed.budget.occupied !== null &&
              observed.budget.confidence !== 'unknown'
                ? ('observed' as const)
                : ('unknown' as const)
          }
        : null
      const view: ConversationPreparationView = {
        operationKey,
        workspaceObservation: 'unknown',
        conversationId: intent.conversationId,
        operationVersion: intent.version,
        contextGeneration: intent.contextGeneration,
        phase: intent.phase,
        activeSessionId:
          readSegments(db, intent.conversationId).find(
            (s) => s.segmentId === conversation?.activeSegmentId
          )?.sessionId ?? null,
        selectedSessionId: intent.targetSessionId,
        approvalRevision: request ? request.expectedApprovalRevision + 1 : 0,
        target,
        preview: null,
        status: target ? 'recipient-choice' : 'target-unavailable'
      }
      const row = db
        .prepare(
          'SELECT manifest_id FROM conversation_preparation_previews WHERE operation_key=? ORDER BY rowid DESC LIMIT 1'
        )
        .get(operationKey)
      if (typeof row?.manifest_id !== 'string') {
        return view
      }
      try {
        const p = authority.readPreview(row.manifest_id)
        if (p?.target.workspaceObservation && observed?.workspaceObservation) {
          view.workspaceObservation = compareWorkspaceWatchObservation(
            p.target.workspaceObservation,
            observed.workspaceObservation
          )
        }
        if (!p || !input.readEvidence(db, p.manifest)) {
          view.status = 'stale'
          return view
        }
        const m = p.manifest
        view.preview = {
          manifestDigest: m.digest,
          targetBindingDigest: m.targetBindingDigest,
          capabilityFingerprint: m.target.capabilityFingerprint,
          transformationsDigest: m.transformationsDigest,
          omissionsDigest: m.omissionsDigest,
          policy: m.policy,
          completeness: m.completeness,
          sourceCount: p.sources.enumeration.sourceCount,
          gapCount: m.evidenceIndex ? null : m.gaps.length,
          gapCountComplete: !m.evidenceIndex,
          inputEstimate: m.inputTokens,
          estimateConfidence: m.inputTokenConfidence ?? 'unknown',
          consented: readConversationPreparationConsent(db, m.manifestId) !== null
        }
        view.status = 'preview'
      } catch (error) {
        if (!(error instanceof ConversationPreparationStaleError)) {
          throw error
        }
        view.status = 'stale'
      }
      return view
    },
    approveRecipient(choice, callerKey) {
      const intent = readSwitchIntent(db, choice.operationKey)
      const observed = intent && input.readTarget(intent.targetSessionId)
      if (
        !intent ||
        !observed ||
        conversationContextDigest(observed.target) !== choice.targetBindingDigest ||
        observed.target.capabilityFingerprint !== choice.capabilityFingerprint
      ) {
        throw new ConversationRpcRefusal('stale-preview')
      }
      approveConversationPreparationRequest(
        db,
        {
          ...choice,
          targetSessionId: intent.targetSessionId,
          targetBindingDigest: conversationContextDigest(observed.target),
          capabilityFingerprint: observed.target.capabilityFingerprint
        },
        callerKey
      )
    },
    approveManifest(choice, callerKey) {
      const preview = currentPreview(choice.manifestDigest)
      if (!preview || !input.readEvidence(db, preview.manifest)) {
        throw new ConversationRpcRefusal('stale-preview')
      }
      approveConversationPreparation(db, choice, callerKey, authority)
    }
  }
}
