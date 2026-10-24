import type { RpcClient } from '../transport/rpc-client'
import { ConversationWatchEventSchema } from '../../../src/shared/conversation-surface-rpc'
import {
  ConversationReaderOwnerChangedError,
  type ConversationReaderPort
} from '../../../src/shared/conversation-history-rpc-schema'
import {
  conversationSurfaceRead,
  conversationSegmentsRead,
  conversationHistoryRead,
  conversationUnwatch
} from './mobile-conversation-read-operations'

export type MobileConversationClient = Pick<
  RpcClient,
  'sendRequest' | 'subscribe' | 'getGeneration' | 'onStateChange'
>
export function createMobileConversationReader(
  client: MobileConversationClient,
  conversationId: string,
  workspaceId: string,
  generation = client.getGeneration?.()
): ConversationReaderPort {
  const options = { timeoutMs: 15_000, failWhenDisconnected: true }
  const current = () => client.getGeneration?.() === generation
  function check(signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (!current()) {
      throw new ConversationReaderOwnerChangedError()
    }
  }
  return {
    async snapshot(signal) {
      check(signal)
      const response = await conversationSurfaceRead.request(client, { conversationId }, options)
      check(signal)
      const result = conversationSurfaceRead.interpret(response)
      if (
        !result ||
        result.conversation.conversationId !== conversationId ||
        result.conversation.location.workspaceId !== workspaceId ||
        (result.surface && result.surface.conversationId !== conversationId)
      ) {
        throw new Error('Conversation unavailable')
      }
      return result
    },
    async segments(beforeOrdinal, signal) {
      check(signal)
      const response = await conversationSegmentsRead.request(
        client,
        { conversationId, segmentPage: { beforeOrdinal, limit: 16 } },
        options
      )
      check(signal)
      const result = conversationSegmentsRead.interpret(response)
      if (
        !result ||
        result.conversation.conversationId !== conversationId ||
        result.conversation.location.workspaceId !== workspaceId ||
        result.segments.some((segment) => segment.conversationId !== conversationId)
      ) {
        throw new Error('Conversation unavailable')
      }
      return result
    },
    async history(segmentId, expectedSourceRevision, after, signal) {
      check(signal)
      const response = await conversationHistoryRead.request(
        client,
        {
          conversationId,
          segmentId,
          expectedSourceRevision,
          after,
          direction: 'backward',
          limit: 128
        },
        options
      )
      check(signal)
      const result = conversationHistoryRead.interpret(response)
      if (
        !result ||
        result.segmentId !== segmentId ||
        result.sourceRevision !== expectedSourceRevision ||
        result.items.some((row) => row.segmentId !== segmentId)
      ) {
        throw new Error('Conversation history unavailable')
      }
      return result
    },
    async watch(onChange, onUnavailable, onOwnerChanged = onUnavailable) {
      check()
      let closed = false,
        subscriptionId: string | undefined
      const unwatch = (id: string) => {
        if (current()) {
          void conversationUnwatch.request(client, { subscriptionId: id }, options).catch(() => {})
        }
      }
      const unsubscribe = client.subscribe('conversation.watch', { conversationId }, (raw) => {
        if (!current()) {
          onOwnerChanged()
          return
        }
        const event = ConversationWatchEventSchema.safeParse(raw)
        if (!event.success) {
          onUnavailable()
          return
        }
        if (closed) {
          if (event.data.type === 'ready') {
            unwatch(event.data.subscriptionId)
          }
          return
        }
        if (event.data.type === 'end') {
          onUnavailable()
          return
        }
        if (event.data.state.conversationId !== conversationId) {
          onUnavailable()
          return
        }
        if (event.data.type === 'ready') {
          subscriptionId = event.data.subscriptionId
        }
        onChange()
      })
      const stopState = client.onStateChange(() => {
        if (!current()) {
          onOwnerChanged()
          unsubscribe()
        }
      })
      return () => {
        closed = true
        stopState()
        unsubscribe()
        if (subscriptionId) {
          unwatch(subscriptionId)
        }
      }
    },
    reconnect(callback) {
      return client.onStateChange((state) => {
        if (state === 'connected' && current()) {
          callback()
        }
      })
    }
  }
}
