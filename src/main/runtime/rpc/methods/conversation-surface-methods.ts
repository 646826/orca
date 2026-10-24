import { randomUUID } from 'node:crypto'
import { defineMethod, defineStreamingMethod } from '../core'
import {
  ConversationSurfaceReadParams,
  ConversationSurfaceVisibilityParams,
  ConversationSelectAgentParams,
  ConversationPromoteSurfaceParams,
  ConversationUnwatchParams,
  ConversationSelectAgentResultSchema
} from '../../../../shared/conversation-surface-rpc'
import {
  conversationRpcCaller,
  conversationRpcHost,
  requireConversationRecord
} from './conversation-method-access'
import { readConversationSurface } from './conversation-surface-read'
import { selectConversationAgent } from './conversation-agent-selection'
import { watchConversationChanges } from './conversation-watch'
import { readConversationSourceProvenance } from '../../../native-chat/conversations/conversation-source-provenance-revision'

export const CONVERSATION_SURFACE_METHODS = [
  defineMethod({
    name: 'conversation.setSurfaceVisibility',
    permission: 'workspace',
    params: ConversationSurfaceVisibilityParams,
    handler: async (params, ctx) => {
      conversationRpcCaller(ctx)
      const host = await conversationRpcHost(ctx)
      const conversation = requireConversationRecord(host, ctx, params.conversationId)
      await host.deps.store.conversations.surfaces.setVisibility(params, () => {
        conversationRpcCaller(ctx)
        requireConversationRecord(host, ctx, params.conversationId)
      })
      await ctx.runtime.publishConversationSurfaces(conversation.location.executionHostId)
      return readConversationSurface(host, ctx, params.conversationId)
    }
  }),
  defineMethod({
    name: 'conversation.promoteSurface',
    permission: 'workspace',
    params: ConversationPromoteSurfaceParams,
    handler: async (params, ctx) => {
      conversationRpcCaller(ctx)
      const host = await conversationRpcHost(ctx)
      const conversation = requireConversationRecord(host, ctx, params.conversationId)
      await host.conversationEnrollment.promote(params, () => {
        conversationRpcCaller(ctx)
        requireConversationRecord(host, ctx, params.conversationId)
      })
      await ctx.runtime.publishConversationSurfaces(conversation.location.executionHostId)
      return readConversationSurface(host, ctx, params.conversationId)
    }
  }),
  defineMethod({
    name: 'conversation.surfaceRead',
    permission: 'workspace',
    params: ConversationSurfaceReadParams,
    handler: async (params, ctx) =>
      readConversationSurface(await conversationRpcHost(ctx, 'read'), ctx, params.conversationId)
  }),
  defineMethod({
    name: 'conversation.selectAgent',
    permission: 'workspace',
    params: ConversationSelectAgentParams,
    handler: async (params, ctx) => {
      const result = await selectConversationAgent(params, ctx)
      return ConversationSelectAgentResultSchema.parse({
        decision: result.decision,
        snapshot: readConversationSurface(result.host, ctx, params.conversationId)
      })
    }
  }),
  defineStreamingMethod({
    name: 'conversation.watch',
    permission: 'workspace',
    params: ConversationSurfaceReadParams,
    handler: async (params, ctx, emit) => {
      const host = await conversationRpcHost(ctx, 'read')
      requireConversationRecord(host, ctx, params.conversationId)
      const controller = new AbortController()
      const subscriptionId = `conversation-${ctx.connectionId ?? 'inproc'}-${randomUUID()}`
      const abort = () => controller.abort()
      ctx.runtime.registerSubscriptionCleanup(subscriptionId, abort, ctx.connectionId)
      ctx.signal?.addEventListener('abort', abort, { once: true })
      if (ctx.signal?.aborted) {
        abort()
      }
      let ready = false
      try {
        await watchConversationChanges({
          signal: controller.signal,
          read: () => {
            const conversation = requireConversationRecord(host, ctx, params.conversationId)
            const surface = host.deps.store.conversations.surfaces.read(params.conversationId)
            const intent = conversation.pendingOperationKey
              ? host.deps.store.conversations.intent(conversation.pendingOperationKey)
              : null
            const state = {
              conversationId: conversation.conversationId,
              revision: conversation.revision,
              contextGeneration: conversation.contextGeneration,
              activationFence: conversation.activationFence,
              activeSegmentId: conversation.activeSegmentId,
              pendingOperationKey: conversation.pendingOperationKey,
              surfaceRevision: surface?.surfaceRevision ?? 0,
              historyInvalidated: true
            }
            return {
              token: JSON.stringify([
                state,
                intent?.version,
                readConversationSourceProvenance(
                  host.deps.journalDatabase.db,
                  params.conversationId,
                  ''
                )
              ]),
              state
            }
          },
          emit: (state) => {
            emit(ready ? { type: 'changed', state } : { type: 'ready', subscriptionId, state })
            ready = true
          }
        })
      } finally {
        ctx.signal?.removeEventListener('abort', abort)
        ctx.runtime.cleanupSubscription(subscriptionId)
        emit({ type: 'end' })
      }
    }
  }),
  defineMethod({
    name: 'conversation.unwatch',
    permission: 'workspace',
    params: ConversationUnwatchParams,
    handler: async (params, ctx) => {
      conversationRpcCaller(ctx)
      await conversationRpcHost(ctx, 'read')
      if (!params.subscriptionId.startsWith(`conversation-${ctx.connectionId ?? 'inproc'}-`)) {
        return { unsubscribed: false }
      }
      ctx.runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
] as const
