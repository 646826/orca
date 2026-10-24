import type {
  ConversationEvidenceLaunchCapture,
  ConversationEvidencePendingRegistration
} from './conversation-evidence-registration'
export type { ConversationEvidenceLaunchCapture } from './conversation-evidence-registration'
import type Database from '../../sqlite/sync-database'
import { readConversation, readParticipant, readSwitchIntent } from './conversation-read-model'
import { conversationContextDigest } from './conversation-context-consent'
import {
  approveConversationEvidenceTrust,
  isConversationEvidenceTrustApproved,
  readConversationEvidenceTrustChoice,
  type ConversationEvidenceLaunchReader
} from './conversation-evidence-trust'
import type { ConversationEvidenceTransport } from './conversation-evidence-tool-contract'

export type ConversationEvidenceObservedLaunch = {
  sessionId: string
  launchFingerprint: string
  transport: ConversationEvidenceTransport
}
export class ConversationEvidenceStartupTrustRequiredError extends Error {
  constructor() {
    super('Conversation evidence tool startup trust is required')
    this.name = 'ConversationEvidenceStartupTrustRequiredError'
  }
}

/** Observe only the actual resolved launch, never execute launch resolution to preview trust. */
export function createConversationEvidenceLaunchGate(db: Database.Database) {
  const observations = new Map<string, ConversationEvidenceObservedLaunch>()
  function record(observed: ConversationEvidenceObservedLaunch) {
    if (!observations.has(observed.sessionId) && observations.size >= 16) {
      throw new Error('Conversation evidence launch observation limit reached')
    }
    observations.set(observed.sessionId, structuredClone(observed))
  }
  const readLaunch: ConversationEvidenceLaunchReader = (sessionId) =>
    observations.get(sessionId) ?? null
  const read = (operationKey: string) =>
    readConversationEvidenceTrustChoice(db, operationKey, readLaunch)
  return {
    readLaunch,
    read,
    capture(
      sessionId: string,
      signal: AbortSignal | undefined,
      prepare: (
        resuming: boolean,
        pending: { assertScope: () => void }
      ) => ConversationEvidencePendingRegistration,
      expectedOperationKey: string | null
    ): ConversationEvidenceLaunchCapture | undefined {
      signal?.throwIfAborted()
      const participant = readParticipant(db, sessionId)
      const conversation = participant && readConversation(db, participant.conversationId)
      if ((conversation?.pendingOperationKey ?? null) !== expectedOperationKey) {
        throw new Error('Conversation evidence launch operation changed')
      }
      const intent =
        conversation?.pendingOperationKey && readSwitchIntent(db, conversation.pendingOperationKey)
      if (!intent || intent.targetSessionId !== sessionId) {
        if (participant?.state === 'parked') {
          throw new Error('Parked participant has no current candidate launch')
        }
        return undefined
      }
      const captured = conversationContextDigest({
        operationKey: intent.operationKey,
        candidateSegmentId: intent.candidateSegmentId,
        contextGeneration: intent.contextGeneration,
        activationFence: intent.activationFence,
        nativeBindingGeneration: participant?.nativeBindingGeneration
      })
      const assertCurrent = () => {
        signal?.throwIfAborted()
        const current = readSwitchIntent(db, intent.operationKey)
        const state = readConversation(db, intent.conversationId)
        const target = readParticipant(db, sessionId)
        if (
          !current ||
          !state ||
          !target ||
          state.pendingOperationKey !== intent.operationKey ||
          ['cancelled', 'failed', 'activated'].includes(current.phase) ||
          state.contextGeneration !== intent.contextGeneration ||
          conversationContextDigest({
            operationKey: current.operationKey,
            candidateSegmentId: current.candidateSegmentId,
            contextGeneration: current.contextGeneration,
            activationFence: current.activationFence,
            nativeBindingGeneration: target.nativeBindingGeneration
          }) !== captured
        ) {
          throw new Error('Conversation evidence launch capture changed')
        }
      }
      assertCurrent()
      return {
        observe(observed) {
          assertCurrent()
          record({
            sessionId,
            launchFingerprint: observed.launchFingerprint,
            transport: observed.transport
          })
          const choice = read(intent.operationKey)
          if (!isConversationEvidenceTrustApproved(db, choice)) {
            throw new ConversationEvidenceStartupTrustRequiredError()
          }
          const registration = prepare(observed.resuming, { assertScope: assertCurrent })
          return {
            registration,
            assertBeforeSpawn() {
              assertCurrent()
              if (
                read(intent.operationKey).choiceDigest !== choice.choiceDigest ||
                !isConversationEvidenceTrustApproved(db, choice)
              ) {
                throw new ConversationEvidenceStartupTrustRequiredError()
              }
            }
          }
        }
      }
    },
    approve(input: { operationKey: string; choiceDigest: string }, callerKey: string) {
      approveConversationEvidenceTrust(db, { ...input, callerKey, now: Date.now() }, readLaunch)
    },
    forget(sessionId: string) {
      observations.delete(sessionId)
    },
    observe(observed: ConversationEvidenceObservedLaunch, signal?: AbortSignal) {
      signal?.throwIfAborted()
      const participant = readParticipant(db, observed.sessionId)
      const conversation = participant && readConversation(db, participant.conversationId)
      if (!conversation?.pendingOperationKey) {
        return { kind: 'not-required' as const }
      }
      record(observed)
      const choice = read(conversation.pendingOperationKey)
      if (choice.scope.targetSessionId !== observed.sessionId) {
        throw new Error('Evidence launch target changed')
      }
      if (!isConversationEvidenceTrustApproved(db, choice)) {
        return { kind: 'trust-required' as const, choice }
      }
      return {
        kind: 'approved' as const,
        choice,
        assertBeforeSpawn() {
          signal?.throwIfAborted()
          const current = read(choice.scope.operationKey)
          if (
            conversationContextDigest(current) !== conversationContextDigest(choice) ||
            !isConversationEvidenceTrustApproved(db, choice)
          ) {
            throw new ConversationEvidenceStartupTrustRequiredError()
          }
        }
      }
    }
  }
}
