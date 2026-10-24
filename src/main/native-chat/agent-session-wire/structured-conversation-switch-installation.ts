import type {
  ConversationPreparationControls,
  ConversationEvidenceTrustControls
} from '../conversations/conversation-preparation-controls'
import type { ConversationDeliveryHost } from '../conversations/conversation-delivery-plan'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionConversationLifetime } from './structured-agent-session-conversation-lifetime'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { startStructuredAgentSessionAgent } from './structured-agent-session-agent-start'
import { createStructuredConversationSwitchRuntime } from './structured-conversation-switch-runtime'
import type { ConversationSwitchPreparationService } from './structured-conversation-switch-runtime-contracts'

export type ConversationPreparationHostAccess = Pick<
  ConversationDeliveryHost,
  'getRecord' | 'getJournal'
> & {
  resolveWorkspacePath?: StructuredAgentSessionHostDeps['resolveWorkspacePath']
  contextDeliveryCapabilities: StructuredAgentSessionAdapter['contextDeliveryCapabilities']
  readOptionRestoreFailures?: StructuredAgentSessionAdapter['readOptionRestoreFailures']
  projectOptions?: StructuredAgentSessionAdapter['projectOptions']
}
export type ConversationPreparationFactory = (access: ConversationPreparationHostAccess) => {
  captureConversationEvidenceLaunch?: StructuredAgentSessionHostDeps['captureConversationEvidenceLaunch']
  bindConversationEvidencePlan?: StructuredAgentSessionHostDeps['bindConversationEvidencePlan']
  controls?: ConversationPreparationControls
  evidenceTrust?: ConversationEvidenceTrustControls
  preparation: ConversationSwitchPreparationService
  readPreparationEvidence: ConversationDeliveryHost['readPreparationEvidence']
  readPreDispatchPreparationEvidence?: ConversationDeliveryHost['readPreDispatchPreparationEvidence']
  canRetrieve: ConversationDeliveryHost['canRetrieve']
}

export function installStructuredConversationSwitchRuntime(input: {
  deps: StructuredAgentSessionHostDeps
  attachContext(): StructuredAgentSessionAttachContext
  lifetime: StructuredAgentSessionConversationLifetime
  flushEvents(sessionId: string): Promise<void>
  now(): number
}) {
  const { deps } = input
  if (!deps.conversationPreparationFactory) {
    return null
  }
  if (
    deps.conversationSwitchRuntime ||
    deps.conversationDeliveryHost ||
    deps.conversationTransferAuthority
  ) {
    throw new Error('Conversation runtime is already installed')
  }
  const access: ConversationPreparationHostAccess = {
    getRecord: (id) => deps.store.getRecord(id),
    resolveWorkspacePath: deps.resolveWorkspacePath,
    getJournal: (id) => input.attachContext().sessions.get(id)?.journal ?? null,
    contextDeliveryCapabilities: deps.adapter.contextDeliveryCapabilities?.bind(deps.adapter),
    readOptionRestoreFailures: deps.adapter.readOptionRestoreFailures?.bind(deps.adapter),
    projectOptions: deps.adapter.projectOptions?.bind(deps.adapter)
  }
  const service = deps.conversationPreparationFactory(access)
  const deliveryHost: ConversationDeliveryHost = {
    ...access,
    readPreparationEvidence: service.readPreparationEvidence,
    readPreDispatchPreparationEvidence: service.readPreDispatchPreparationEvidence,
    canRetrieve: service.canRetrieve
  }
  const composition = createStructuredConversationSwitchRuntime({
    db: deps.journalDatabase.db,
    stateDirectory: deps.journalDatabase.stateDirectory,
    deliveryHost,
    preparation: service.preparation,
    now: input.now,
    reportContinuationFailure: (operationKey, error) =>
      deps.logger.warn('Conversation queued continuation remains pending', {
        scope: 'conversation-continuation',
        operationKey,
        error
      }),
    flushEvents: input.flushEvents,
    wakeDelivery: (id, signal) =>
      input.attachContext().serialize(id, async () => {
        signal.throwIfAborted()
        const wake = input.attachContext().wakeDelivery
        if (!wake) {
          throw new Error('Conversation delivery wake unavailable')
        }
        wake(id)
      }),
    publishSourceQueue: (id) => {
      const journal = access.getJournal(id)
      if (journal) {
        input.attachContext().subscribers.publish(id, journal)
      }
    },
    ensureCandidate: async (intent, signal) => {
      signal.throwIfAborted()
      await input.lifetime.conversation(intent.targetSessionId)
      signal.throwIfAborted()
      const outcome = await startStructuredAgentSessionAgent(
        input.attachContext(),
        intent.targetSessionId,
        undefined,
        intent.operationKey
      )
      signal.throwIfAborted()
      if (!outcome.ok) {
        throw new Error('Candidate native acquisition refused', { cause: outcome.refusal })
      }
    }
  })
  deps.conversationPreparationControls = service.controls
  deps.captureConversationEvidenceLaunch = service.captureConversationEvidenceLaunch
  deps.bindConversationEvidencePlan = service.bindConversationEvidencePlan
  deps.conversationEvidenceTrust = service.evidenceTrust
  deps.conversationDeliveryHost = deliveryHost
  deps.conversationSwitchRuntime = composition.runtime
  deps.conversationTransferAuthority = composition.transferAuthority
  return { ...composition, controls: service.controls }
}
