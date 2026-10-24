import {
  NATIVE_CONVERSATION_RUNTIME_CAPABILITY,
  NATIVE_CONVERSATION_TRANSFER_RECOVERY_CAPABILITY
} from '../../../../shared/conversation-runtime-capabilities'
import {
  ConversationTransferRecoveryParams,
  ConversationTransferIntentionsParams
} from '../../../../shared/conversation-transfer-recovery'
import { ConversationRpcRefusal } from '../../../../shared/conversation-rpc-refusal'
import { readConversationTransferIntentions } from '../../../native-chat/conversations/conversation-transfer-recovery-view'
import { defineMethod, type RpcContext } from '../core'
import {
  conversationOperationHost,
  conversationRpcCaller,
  conversationRpcHost,
  requireConversationRecord
} from './conversation-method-access'
import { boundedConversationResult } from './conversation-public-result'

function requireRecoveryCapability(ctx: RpcContext): void {
  if (
    ctx.clientKind !== undefined &&
    !ctx.clientCapabilities?.includes(NATIVE_CONVERSATION_TRANSFER_RECOVERY_CAPABILITY)
  ) {
    throw new ConversationRpcRefusal('unsupported')
  }
}

export const CONVERSATION_TRANSFER_RECOVERY_METHODS = [
  defineMethod({
    name: 'conversation.transferIntentions',
    permission: 'workspace',
    params: ConversationTransferIntentionsParams,
    handler: async (params, ctx) => {
      requireRecoveryCapability(ctx)
      const host = await conversationRpcHost(ctx, 'read')
      requireConversationRecord(host, ctx, params.conversationId)
      return boundedConversationResult(
        readConversationTransferIntentions({
          db: host.deps.journalDatabase.db,
          stateDirectory: host.deps.journalDatabase.stateDirectory,
          currentRuntimeFence: (proof) =>
            ctx.clientKind === undefined ||
            (ctx.clientKind !== 'mobile' &&
              ctx.clientCapabilities?.includes(NATIVE_CONVERSATION_RUNTIME_CAPABILITY))
              ? host.deps.store.conversations.currentTransferRecoveryFence(proof)
              : null,
          ...params
        })
      )
    }
  }),
  defineMethod({
    name: 'conversation.recoverTransfer',
    permission: 'workspace',
    params: ConversationTransferRecoveryParams,
    handler: async (params, ctx) => {
      requireRecoveryCapability(ctx)
      if (ctx.clientKind === 'mobile') {
        throw new ConversationRpcRefusal('unsupported')
      }
      const caller = conversationRpcCaller(ctx)
      const { host, intent } = await conversationOperationHost(ctx, params.operationKey)
      const result = await host.recoverConversationTransfer(params, caller, ctx.signal)
      const conversation = host.deps.store.conversations.read(intent.conversationId)
      if (conversation) {
        await ctx.runtime.publishConversationSurfaces(conversation.location.executionHostId)
      }
      return boundedConversationResult(result)
    }
  })
] as const
