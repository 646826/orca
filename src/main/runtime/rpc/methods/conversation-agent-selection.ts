import { nameBasedUuid } from '../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { agentSessionAccountHomesEqual } from '../../../../shared/agent-session-account-home'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import { agentSessionOperationKey } from '../../../../shared/agent-session-operation-ledger'
import { ConversationRpcRefusal } from '../../../../shared/conversation-rpc-refusal'
import type { ConversationSelectAgentRequest } from '../../../../shared/conversation-surface-rpc'
import type { RpcContext } from '../core'
import {
  conversationRpcCaller,
  conversationRpcHost,
  requireConversationRecord
} from './conversation-method-access'
import { prepareStructuredAgentSessionCreateForWorktree } from './structured-agent-session-create'
import { requireStructuredAgentAudience } from './structured-agent-session-gate'
import { sameScope } from '../../../native-chat/conversations/conversation-store-transitions'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'

export async function selectConversationAgent(
  params: ConversationSelectAgentRequest,
  ctx: RpcContext
) {
  const callerKey = conversationRpcCaller(ctx)
  const host = await conversationRpcHost(ctx)
  const conversation = requireConversationRecord(host, ctx, params.conversationId)
  requireStructuredAgentAudience(ctx, params.agent)
  const operation = {
    callerKey,
    operationId: params.clientOperationId,
    now: Date.now(),
    fingerprint: computeAgentSessionPayloadFingerprint({
      method: 'conversation.selectAgent',
      sessionId: params.conversationId,
      fields: params
    })
  }
  const prior = host.deps.store.conversations.intent(
    agentSessionOperationKey(callerKey, operation.operationId)
  )
  if (prior && prior.conversationId !== params.conversationId) {
    throw new ConversationRpcRefusal('identity-mismatch')
  }
  const candidateId =
    prior?.targetSessionId ??
    nameBasedUuid(
      JSON.stringify([
        'conversation-candidate',
        params.conversationId,
        callerKey,
        operation.operationId
      ])
    )
  const generation = {
    conversationId: params.conversationId,
    expectedRevision: params.expectedRevision,
    expectedContextGeneration: params.expectedContextGeneration,
    expectedActivationFence: params.expectedActivationFence
  }
  if (prior) {
    const record = host.deps.store.getRecord(prior.targetSessionId)
    if (!record) {
      throw new ConversationRpcRefusal('target-unavailable')
    }
    const result = await host.conversationEnrollment.begin(
      {
        ...generation,
        target: record,
        expectedNativeBindingGeneration: prior.nativeBindingGeneration
      },
      operation
    )
    if (result.decision.decision === 'refused') {
      throw agentSessionRefusalError(result.decision.code, result.decision.details)
    }
    return { decision: 'replayed' as const, host, intent: result.intent }
  }
  const prepared = await prepareStructuredAgentSessionCreateForWorktree({
    runtime: ctx.runtime,
    ensureHost: async () => host,
    envelope: {
      sessionId: candidateId,
      clientOperationId: operation.operationId,
      payloadFingerprint: operation.fingerprint,
      expectedRuntimeFence: null
    },
    worktree: `id:${conversation.location.workspaceId}`,
    agent: params.agent,
    caller: { callerKey },
    atRest: true
  })
  if (!sameScope(prepared.attachParams.location, conversation.location)) {
    throw new ConversationRpcRefusal('scope-mismatch')
  }
  const eligible =
    params.nativeSession === 'retain-or-create'
      ? host.deps.store.conversations
          .segments(conversation.conversationId)
          .toReversed()
          .find((segment) => {
            if (
              segment.contextGeneration !== conversation.contextGeneration ||
              segment.lifecycle === 'candidate'
            ) {
              return false
            }
            const record = host.deps.store.getRecord(segment.sessionId)
            return (
              record?.provider === params.agent &&
              sameScope(record.location, conversation.location) &&
              agentSessionAccountHomesEqual(record.accountHome, prepared.attachParams.accountHome)
            )
          })
      : undefined
  if (eligible?.segmentId === conversation.activeSegmentId) {
    if (
      conversation.revision !== params.expectedRevision ||
      conversation.contextGeneration !== params.expectedContextGeneration ||
      conversation.activationFence !== params.expectedActivationFence ||
      conversation.pendingOperationKey !== null
    ) {
      throw new ConversationRpcRefusal('stale-generation')
    }
    return { decision: 'unchanged' as const, host, intent: null }
  }
  const retained = eligible ? host.deps.store.getRecord(eligible.sessionId) : null
  const target = retained ?? {
    sessionId: candidateId,
    provider: prepared.attachParams.provider,
    location: prepared.attachParams.location,
    accountHome: prepared.attachParams.accountHome
  }
  const request = {
    ...generation,
    target,
    expectedNativeBindingGeneration: eligible?.nativeBindingGeneration ?? 1
  }
  const result = retained
    ? await host.conversationEnrollment.begin(request, operation)
    : await host.conversationEnrollment.found(request, operation, prepared.attachParams, {
        ...(prepared.catalogModels ? { catalogModels: prepared.catalogModels } : {}),
        ...(prepared.hostLaunchDirectory
          ? { hostLaunchDirectory: prepared.hostLaunchDirectory }
          : {})
      })
  if (result.decision.decision === 'refused') {
    throw agentSessionRefusalError(result.decision.code, result.decision.details)
  }
  return {
    decision: result.decision.decision === 'admit' ? ('admitted' as const) : ('replayed' as const),
    host,
    intent: result.intent
  }
}
