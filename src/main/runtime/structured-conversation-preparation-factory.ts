import { createConversationWorkspaceObserver } from './structured-conversation-workspace-observation'
import { readConversationDeliveryPlan } from '../native-chat/conversations/conversation-delivery-plan'
import { readConversationManifest } from '../native-chat/conversations/conversation-context-coverage'
import { createRuntimeConversationEvidence } from './structured-conversation-evidence-runtime'
import type { ConversationDeliveryHost } from '../native-chat/conversations/conversation-delivery-plan'
import { assertConversationPendingNativePublished } from '../native-chat/conversations/conversation-pending-native-identity'
import type Database from '../sqlite/sync-database'
import type { ConversationPreparationFactory } from '../native-chat/agent-session-wire/structured-conversation-switch-installation'
import { createConversationPreparationService } from '../native-chat/conversations/conversation-preparation-service'
import { conversationContextAccountDigest } from '../native-chat/conversations/conversation-context-authority'
import { conversationContextDigest } from '../native-chat/conversations/conversation-context-consent'
import { readParticipant } from '../native-chat/conversations/conversation-read-model'
import { readConversationNativeIdentity } from '../native-chat/conversations/conversation-origin-native-identity'
import { agentSessionLeaseAdmitsWriter } from '../../shared/agent-session-lease-adjudication'
import { getAgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'

export function conversationPreparationModel(
  selected: string | undefined,
  projected: Readonly<Record<string, string>> | undefined
): string | null {
  if (!selected || selected === 'default' || selected === 'provider-default (unreported)') {
    return null
  }
  return projected?.model === selected ? selected : null
}

export function createRuntimeConversationPreparationFactory(
  db: Database.Database,
  stateDirectory: string
): ConversationPreparationFactory {
  return (access) => {
    const workspace = createConversationWorkspaceObserver(access.resolveWorkspacePath)
    let deliveryHost: ConversationDeliveryHost | null = null
    const evidence = createRuntimeConversationEvidence({
      db,
      stateDirectory,
      access,
      deliveryHost: () => deliveryHost
    })
    const service = createConversationPreparationService({
      db,
      stateDirectory,
      store: getAgentSessionAttachmentStore,
      now: Date.now,
      getJournal: access.getJournal.bind(access),
      readTarget: (sessionId) => {
        const record = access.getRecord(sessionId)
        const participant = readParticipant(db, sessionId)
        const capabilities = access.contextDeliveryCapabilities?.(sessionId, record?.provider)
        const projected = record && access.projectOptions?.(sessionId, record.options ?? {})
        const model = conversationPreparationModel(record?.options?.model, projected?.options)
        const restorationFailures = access.readOptionRestoreFailures?.(sessionId) ?? []
        const nativeIdentityDigest = readConversationNativeIdentity(db, sessionId)
        if (
          !record ||
          restorationFailures.length > 0 ||
          model === null ||
          Object.entries(projected?.options ?? {}).some(
            ([key, value]) => record.options?.[key] !== value
          ) ||
          !participant ||
          !nativeIdentityDigest ||
          !agentSessionLeaseAdmitsWriter(record.lease) ||
          capabilities?.state !== 'verified' ||
          capabilities.firstTurnReceipt === 'unsupported'
        ) {
          return null
        }
        assertConversationPendingNativePublished(db, {
          sessionId,
          fence: record.lease.runtimeFence,
          acquisitionGeneration: capabilities.acquisitionGeneration
        })
        const registration = evidence.registry.readRegistration(sessionId)
        return {
          target: {
            sessionId,
            provider: record.provider,
            accountBindingDigest: conversationContextAccountDigest(record),
            nativeBindingGeneration: participant.nativeBindingGeneration,
            capabilityFingerprint:
              registration?.capabilityFingerprint ?? capabilities.runtimeFingerprint,
            model,
            retrieval: registration ? 'verified' : 'unsupported'
          },
          budget: null,
          nativeIdentityDigest,
          runtimeFence: record.lease.runtimeFence,
          optionsDigest: conversationContextDigest(record.options ?? null),
          freshNative: false,
          workspaceObservation: workspace.read(record)
        }
      }
    })
    deliveryHost = {
      ...access,
      readPreparationEvidence: service.readPreparationEvidence,
      readPreDispatchPreparationEvidence: service.readPreDispatchPreparationEvidence,
      canRetrieve: evidence.registry.canRetrieve
    }
    return {
      ...service,
      preparation: {
        ...service.preparation,
        async prepare(intent, previousManifestId, signal, trigger) {
          const record = access.getRecord(intent.targetSessionId)
          if (record) {
            await workspace.resolve(record, signal)
          }
          return service.preparation.prepare(intent, previousManifestId, signal, trigger)
        }
      },
      canRetrieve: evidence.registry.canRetrieve,
      evidenceTrust: evidence.evidenceTrust,
      captureConversationEvidenceLaunch: evidence.captureConversationEvidenceLaunch,
      async bindConversationEvidencePlan(sessionId: string, planId: string, signal: AbortSignal) {
        signal.throwIfAborted()
        const plan = readConversationDeliveryPlan(db, planId)
        const manifest = plan && readConversationManifest(db, plan.manifestId)
        if (!plan || !manifest || plan.targetSessionId !== sessionId) {
          throw new Error('Evidence delivery plan unavailable')
        }
        if (manifest.target.retrieval !== 'verified') {
          return
        }
        await evidence.registry.bindPlan(sessionId, planId)
        signal.throwIfAborted()
      }
    }
  }
}
