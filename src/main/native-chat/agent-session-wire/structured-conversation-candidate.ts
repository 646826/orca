import { agentSessionOperationKey } from '../../../shared/agent-session-operation-ledger'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { reserveRequestFor, type AgentSessionAttachParams } from './structured-agent-session-attach'
import type { StructuredAgentSessionCreateOptions } from './structured-agent-session-create'
import {
  pinnedAgentSessionLaunchArgs,
  pinnedAgentSessionLaunchEnv
} from './structured-agent-session-launch-env'
import { foundAgentSessionRecord } from '../../runtime/agent-session-record-founding'
import { openStructuredAgentSessionConversationJournal } from './structured-agent-session-conversation-open'
import { hostCanStartRecord } from './structured-agent-session-provider-support'
import { ConversationRefusal } from '../conversations/conversation-read-model'
import type { ConversationSwitchRequest } from '../../../shared/conversation-wire'
import type { AgentSessionOperationAdmission } from '../../runtime/agent-session-operation-admission'

/** Only founding/journal work holds the target queue; acquiring the native agent is a later step. */
export function foundStructuredConversationCandidate(
  context: StructuredAgentSessionAttachContext,
  switchRequest: ConversationSwitchRequest,
  operation: AgentSessionOperationAdmission,
  params: AgentSessionAttachParams,
  options: Pick<StructuredAgentSessionCreateOptions, 'hostLaunchDirectory' | 'catalogModels'>
) {
  return context.serialize(params.envelope.sessionId, async () => {
    const existing = context.deps.store.conversations.intent(
      agentSessionOperationKey(operation.callerKey, operation.operationId)
    )
    // Replay goes through the existing ledger before consulting mutable launch defaults.
    if (existing) {
      return context.deps.store.conversations.beginSwitch(switchRequest, operation)
    }
    if (params.agent !== params.provider || params.envelope.expectedRuntimeFence !== null) {
      throw new ConversationRefusal('identity-mismatch')
    }
    const request = reserveRequestFor({
      sessionId: params.envelope.sessionId,
      params,
      models: options.catalogModels,
      callerKey: operation.callerKey,
      fingerprint: operation.fingerprint,
      now: operation.now,
      authority: {
        ...(options.hostLaunchDirectory ? { launchDirectory: options.hostLaunchDirectory } : {}),
        spawnToken: () => {
          throw new Error('candidate founding cannot spawn')
        },
        claimKeyId: context.deps.claimKeyId,
        handoffOperationId: null,
        probe: { outcome: 'pid-absent' },
        ...(await pinnedAgentSessionLaunchArgs(context.deps.resolveLaunchArgs, params)),
        ...(await pinnedAgentSessionLaunchEnv(context.deps.resolveLaunchEnv, params))
      }
    })
    const record = foundAgentSessionRecord(request, request)
    if (!hostCanStartRecord(context.deps, record)) {
      throw new ConversationRefusal('identity-mismatch')
    }
    const opened = await openStructuredAgentSessionConversationJournal(context.deps, record)
    try {
      return await context.deps.store.conversations.beginSwitch(switchRequest, operation, request)
    } finally {
      await opened.session.journal.close()
    }
  })
}
