import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  conversationHistoryPageSchema as history,
  conversationSegmentPageSchema as segments,
  type ConversationHistoryCursor
} from '../../../shared/conversation-history-rpc-schema'
export type {
  ConversationHistoryPage,
  ConversationSegmentPage
} from '../../../shared/conversation-history-rpc-schema'
import {
  ConversationSurfaceSnapshotSchema,
  ConversationWatchEventSchema
} from '../../../shared/conversation-surface-rpc'
import { captureConversationReaderOwner } from './conversation-reader-owner'
import { subscribeRuntimeRpc } from './runtime-rpc-subscribe'
import { subscribeRuntimeHostContactRegained } from './runtime-host-contact-regained'
export function createRuntimeConversationReader(
  target: RuntimeClientTarget,
  conversationId: string
) {
  target = { ...target }
  const owner = captureConversationReaderOwner(target)
  async function call(method: string, params: unknown, signal?: AbortSignal) {
    return owner.request(method, params, { signal })
  }
  return {
    async snapshot(signal: AbortSignal) {
      const snapshot = ConversationSurfaceSnapshotSchema.parse(
        await call('conversation.surfaceRead', { conversationId }, signal)
      )
      if (
        snapshot.conversation.conversationId !== conversationId ||
        (snapshot.surface && snapshot.surface.conversationId !== conversationId)
      ) {
        throw new Error('Conversation scope changed')
      }
      return snapshot
    },
    async segments(beforeOrdinal: number | null, signal: AbortSignal) {
      const page = segments.parse(
        await call(
          'conversation.read',
          { conversationId, segmentPage: { beforeOrdinal, limit: 16 } },
          signal
        )
      )
      if (
        page.conversation.conversationId !== conversationId ||
        page.segments.some((segment) => segment.conversationId !== conversationId)
      ) {
        throw new Error('Conversation scope changed')
      }
      return page
    },
    async history(
      segmentId: string,
      expectedSourceRevision: string,
      after: ConversationHistoryCursor | null,
      signal: AbortSignal
    ) {
      const page = history.parse(
        await call(
          'conversation.history',
          {
            conversationId,
            segmentId,
            expectedSourceRevision,
            after,
            direction: 'backward',
            limit: 128
          },
          signal
        )
      )
      if (
        page.segmentId !== segmentId ||
        page.sourceRevision !== expectedSourceRevision ||
        page.items.some((item) => item.segmentId !== segmentId)
      ) {
        throw new Error('Conversation history scope changed')
      }
      return page
    },
    async watch(
      onChange: () => void,
      onUnavailable: () => void,
      onOwnerChanged: () => void = onUnavailable
    ) {
      owner.assertCurrent()
      const stopOwner = owner.subscribe(onOwnerChanged)
      let subscriptionId: string | undefined
      let closed = false
      const unwatch = (id: string) => {
        void call('conversation.unwatch', { subscriptionId: id }).catch(() => {})
      }
      const subscription = await subscribeRuntimeRpc(
        target,
        'conversation.watch',
        { conversationId },
        {
          onEvent: (raw) => {
            if (!owner.current()) {
              onOwnerChanged()
              return
            }
            const parsed = ConversationWatchEventSchema.safeParse(raw)
            if (!parsed.success) {
              onUnavailable()
              return
            }
            const event = parsed.data
            if (closed) {
              if (event.type === 'ready') {
                unwatch(event.subscriptionId)
              }
              return
            }
            if (event.type === 'end') {
              onUnavailable()
              return
            }
            if (event.state.conversationId !== conversationId) {
              onUnavailable()
              return
            }
            if (event.type === 'ready') {
              subscriptionId = event.subscriptionId
            }
            onChange()
          },
          onClose: onUnavailable,
          onError: onUnavailable
        },
        owner.options
      ).catch((error: unknown) => {
        stopOwner()
        throw error
      })
      if (!owner.current()) {
        subscription.unsubscribe()
        stopOwner()
        owner.assertCurrent()
      }
      return () => {
        closed = true
        stopOwner()
        subscription.unsubscribe()
        if (subscriptionId) {
          unwatch(subscriptionId)
        }
      }
    },
    reconnect: (callback: () => void) =>
      target.kind === 'environment'
        ? subscribeRuntimeHostContactRegained(target.environmentId, callback)
        : () => {}
  }
}
export type RuntimeConversationReader = ReturnType<typeof createRuntimeConversationReader>
