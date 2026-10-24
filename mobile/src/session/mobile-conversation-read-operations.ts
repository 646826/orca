import { z } from 'zod'
import { ConversationSurfaceSnapshotSchema } from '../../../src/shared/conversation-surface-rpc'
import {
  conversationHistoryPageSchema,
  conversationSegmentPageSchema
} from '../../../src/shared/conversation-history-rpc-schema'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

export const conversationSurfaceRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'conversation.surfaceRead',
    method: 'conversation.surfaceRead',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('conversation-surface', ConversationSurfaceSnapshotSchema)
  })
)
export const conversationSegmentsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'conversation.read',
    method: 'conversation.read',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('conversation-segments', conversationSegmentPageSchema)
  })
)
export const conversationHistoryRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'conversation.history',
    method: 'conversation.history',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('conversation-history', conversationHistoryPageSchema)
  })
)
export const conversationUnwatch = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'conversation.unwatch',
    method: 'conversation.unwatch',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('conversation-unwatch', z.unknown())
  })
)
