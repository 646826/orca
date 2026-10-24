import { defineMethod } from '../core'
import type { RpcContext } from '../core'
import {
  ConversationClearParams,
  ConversationAdvanceParams,
  ConversationOperationParams
} from '../../../../shared/rpc-contract/conversation-params'
import {
  conversationRpcCaller,
  conversationRpcHost,
  requireConversationRecord
} from './conversation-method-access'
import { ConversationRpcRefusal } from '../../../../shared/conversation-rpc-refusal'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import type { ConversationClearIntent } from '../../../../shared/conversation-clear-record'

function view(intent: ConversationClearIntent) {
  const {
    operationKey,
    conversationId,
    version,
    contextGeneration,
    activationFence,
    phase,
    preserveArchive
  } = intent
  return {
    operationKey,
    conversationId,
    version,
    contextGeneration,
    activationFence,
    phase,
    preserveArchive
  }
}
async function operationHost(ctx: RpcContext, key: string) {
  conversationRpcCaller(ctx)
  const host = await conversationRpcHost(ctx)
  const intent = host.deps.store.conversations.clear.intent(key)
  if (!intent) {
    throw new ConversationRpcRefusal('missing-record')
  }
  requireConversationRecord(host, ctx, intent.conversationId)
  return { host, intent }
}
export const CONVERSATION_CLEAR_METHODS = [
  defineMethod({
    name: 'conversation.clear',
    permission: 'workspace',
    params: ConversationClearParams,
    handler: async (params, ctx) => {
      const callerKey = conversationRpcCaller(ctx)
      const host = await conversationRpcHost(ctx)
      requireConversationRecord(host, ctx, params.conversationId)
      const { clientOperationId, ...request } = params
      const result = await host.deps.store.conversations.clear.begin(request, {
        callerKey,
        operationId: clientOperationId,
        now: Date.now(),
        fingerprint: computeAgentSessionPayloadFingerprint({
          method: 'conversation.clear',
          sessionId: params.conversationId,
          fields: request
        })
      })
      return {
        decision: result.decision?.decision ?? 'refused',
        intent: result.intent ? view(result.intent) : null
      }
    }
  }),
  defineMethod({
    name: 'conversation.clearRead',
    permission: 'workspace',
    params: ConversationOperationParams,
    handler: async (params, ctx) => view((await operationHost(ctx, params.operationKey)).intent)
  }),
  defineMethod({
    name: 'conversation.clearAdvance',
    permission: 'workspace',
    params: ConversationAdvanceParams,
    handler: async (params, ctx) => {
      const { host, intent } = await operationHost(ctx, params.operationKey)
      if (intent.version !== params.expectedVersion) {
        throw new ConversationRpcRefusal('stale-generation')
      }
      const result = await host.advanceConversationClear(
        params.operationKey,
        ctx.signal ?? new AbortController().signal
      )
      const conversation = host.deps.store.conversations.read(intent.conversationId)
      if (conversation) {
        await ctx.runtime.publishConversationSurfaces(conversation.location.executionHostId)
      }
      return result
    }
  }),
  defineMethod({
    name: 'conversation.clearCancel',
    permission: 'workspace',
    params: ConversationAdvanceParams,
    handler: async (params, ctx) => {
      const { host } = await operationHost(ctx, params.operationKey)
      return view(await host.deps.store.conversations.clear.cancel(params))
    }
  })
] as const
