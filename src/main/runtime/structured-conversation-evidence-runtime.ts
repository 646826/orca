import { readSwitchIntent } from '../native-chat/conversations/conversation-read-model'
import { ConversationRpcRefusal } from '../../shared/conversation-rpc-refusal'
import type Database from '../sqlite/sync-database'
import type { ConversationPreparationHostAccess } from '../native-chat/agent-session-wire/structured-conversation-switch-installation'
import type { ConversationDeliveryHost } from '../native-chat/conversations/conversation-delivery-plan'
import { createConversationEvidenceRegistry } from '../native-chat/conversations/conversation-evidence-registry'
import { createConversationEvidenceLaunchGate } from '../native-chat/conversations/conversation-evidence-launch-gate'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { agentSessionLeaseAdmitsWriter } from '../../shared/agent-session-lease-adjudication'

export function createRuntimeConversationEvidence(input: {
  db: Database.Database
  stateDirectory: string
  access: ConversationPreparationHostAccess
  deliveryHost(): ConversationDeliveryHost | null
}) {
  const { db, stateDirectory, access } = input
  const gate = createConversationEvidenceLaunchGate(db)
  const registry = createConversationEvidenceRegistry({
    db,
    stateDirectory,
    readLaunch: gate.readLaunch,
    deliveryHost: input.deliveryHost,
    readNative(sessionId) {
      const record = access.getRecord(sessionId)
      const caps = access.contextDeliveryCapabilities?.(sessionId, record?.provider)
      const launch = gate.readLaunch(sessionId)
      const head = record && agentSessionProviderHandleChainHead(record.providerHandleChain)
      if (
        !record ||
        !head ||
        !launch ||
        !agentSessionLeaseAdmitsWriter(record.lease) ||
        caps?.state !== 'verified'
      ) {
        return null
      }
      return {
        nativeSessionId: head.handle.nativeId,
        runtimeFence: record.lease.runtimeFence,
        acquisitionGeneration: caps.acquisitionGeneration,
        baseCapabilityFingerprint: caps.runtimeFingerprint,
        ...launch
      }
    }
  })
  return {
    registry,
    evidenceTrust: {
      read(operationKey: string) {
        const intent = readSwitchIntent(db, operationKey)
        if (!intent || !gate.readLaunch(intent.targetSessionId)) {
          return null
        }
        return gate.read(operationKey)
      },
      approve: gate.approve
    },
    captureConversationEvidenceLaunch(
      sessionId: string,
      fence: number,
      signal: AbortSignal | undefined,
      expectedOperationKey: string | null
    ) {
      const record = access.getRecord(sessionId)
      if (!record || record.lease.runtimeFence !== fence) {
        throw new Error('Evidence acquisition fence changed')
      }
      return gate.capture(
        sessionId,
        signal,
        (resuming, pending) => {
          const registration = registry.prepare(sessionId, resuming, { ...pending, signal })
          if (registration.kind !== 'pending') {
            throw new ConversationRpcRefusal(
              registration.kind === 'native-rebuild-required'
                ? 'native-rebuild-required'
                : 'trust-required'
            )
          }
          return registration
        },
        expectedOperationKey
      )
    }
  }
}
