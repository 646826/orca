import { defineMethod } from '../core'
import {
  ConversationArchiveDeleteParams,
  ConversationArchiveStatusParams,
  ConversationArchiveCleanupParams
} from '../../../../shared/conversation-archive-rpc'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import {
  conversationRpcCaller,
  conversationRpcHost,
  requireConversationRecord
} from './conversation-method-access'

/** Archive deletion never clears live context or claims provider-side erasure. */
export const CONVERSATION_ARCHIVE_METHODS = [
  defineMethod({
    name: 'conversation.archiveStatus',
    permission: 'workspace',
    params: ConversationArchiveStatusParams,
    handler: async (params, ctx) => {
      conversationRpcCaller(ctx)
      const host = await conversationRpcHost(ctx)
      requireConversationRecord(host, ctx, params.conversationId)
      return host.deps.store.conversations.archive.status(
        params.conversationId,
        params.contextGeneration
      )
    }
  }),
  defineMethod({
    name: 'conversation.deleteArchive',
    permission: 'workspace',
    params: ConversationArchiveDeleteParams,
    handler: async (params, ctx) => {
      const callerKey = conversationRpcCaller(ctx)
      const host = await conversationRpcHost(ctx)
      const conversation = requireConversationRecord(host, ctx, params.conversationId)
      const result = await host.deps.store.conversations.archive.remove(
        params,
        {
          callerKey,
          operationId: params.clientOperationId,
          now: Date.now(),
          fingerprint: computeAgentSessionPayloadFingerprint({
            method: 'conversation.deleteArchive',
            sessionId: params.conversationId,
            fields: params
          })
        },
        () => {
          conversationRpcCaller(ctx)
          requireConversationRecord(host, ctx, params.conversationId)
        }
      )
      await ctx.runtime.publishConversationSurfaces(conversation.location.executionHostId)
      return { ...result, cleanupPending: true as const, sharedEvidenceMayRemain: true as const }
    }
  }),
  defineMethod({
    name: 'conversation.cleanupArchive',
    permission: 'workspace',
    params: ConversationArchiveCleanupParams,
    handler: async (params, ctx) => {
      conversationRpcCaller(ctx)
      const host = await conversationRpcHost(ctx)
      requireConversationRecord(host, ctx, params.conversationId)
      return host.deps.store.conversations.archive.cleanup(params, () => {
        conversationRpcCaller(ctx)
        requireConversationRecord(host, ctx, params.conversationId)
      })
    }
  })
]
