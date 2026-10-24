import { createConversationSwitchCoordinator } from '../conversations/conversation-switch'
import {
  ConversationRefusal,
  readConversationDeliverySources
} from '../conversations/conversation-read-model'
import { assertConversationOriginsResolved } from '../conversations/conversation-origin-rows'
import { ConversationOriginUnresolvedError } from '../conversations/conversation-origin'
import { reconcileConversationOrigins } from '../conversations/conversation-origin-reconciliation'
import type {
  ConversationSwitchPorts,
  ConversationSwitchResult
} from '../conversations/conversation-switch-contracts'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import type { StructuredAgentSessionConversationLifetime } from './structured-agent-session-conversation-lifetime'
import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import { readStructuredConversationQuiescence } from './structured-conversation-switch-quiescence'

export type StructuredConversationSwitchRuntime = Omit<
  ConversationSwitchPorts,
  'store' | 'readSources' | 'quiesce'
> & { continueQueued?(operationKey: string): Promise<void> }
export type StructuredConversationSwitchHost = {
  deps: StructuredAgentSessionHostDeps
  sessions: StructuredAgentSessionConversations
  runtimeState: StructuredAgentSessionHostRuntimeState
  clientDelivery: StructuredAgentSessionClientDelivery
  lifetime: StructuredAgentSessionConversationLifetime
  serialize: StructuredAgentSessionTaskQueue['serialize']
}

export function structuredConversationSwitchDelegate(host: () => StructuredConversationSwitchHost) {
  return (operationKey: string, signal: AbortSignal) =>
    advanceStructuredConversationSwitch(host(), operationKey, signal)
}

export async function advanceStructuredConversationSwitch(
  host: StructuredConversationSwitchHost,
  operationKey: string,
  signal: AbortSignal
): Promise<ConversationSwitchResult> {
  const runtime = host.deps.conversationSwitchRuntime
  if (!runtime) {
    return { kind: 'blocked', reasons: ['switch-runtime-unavailable'] }
  }
  const hasOpenDispatch = host.deps.hasOpenDispatch
  if (!hasOpenDispatch) {
    return { kind: 'blocked', reasons: ['owner-unverifiable'] }
  }
  const store = host.deps.store.conversations
  const coordinator = createConversationSwitchCoordinator({
    ...runtime,
    store,
    readSources: (intent) => {
      assertConversationOriginsResolved(
        host.deps.journalDatabase.db,
        intent.conversationId,
        intent.contextGeneration
      )
      return readConversationDeliverySources(
        host.deps.journalDatabase.db,
        intent.conversationId,
        intent.targetSessionId
      )
    },
    quiesce: async (intent) => {
      const sources = [
        ...new Set(
          store
            .segments(intent.conversationId)
            .filter((segment) => segment.contextGeneration === intent.contextGeneration)
            .map((segment) => segment.sessionId)
        )
      ].sort()
      const blockers: string[] = []
      for (const sessionId of sources) {
        signal.throwIfAborted()
        await host.lifetime.conversation(sessionId)
        await host.runtimeState.flushEventSink(sessionId)
        await reconcileConversationOrigins(host.deps.journalDatabase.db, sessionId, signal)
        signal.throwIfAborted()
        const snapshot = await host.serialize(sessionId, async () =>
          readStructuredConversationQuiescence(
            {
              store: host.deps.store,
              sessions: host.sessions,
              adapter: host.deps.adapter,
              readChildWork: host.clientDelivery.readChildWork,
              childWorkOpen: host.clientDelivery.childWorkOpen,
              childWorkIncomplete: host.clientDelivery.childWorkIncomplete,
              starting: (id) => host.runtimeState.startFlights.has(id),
              stopping: (id) => host.sessions.get(id)?.child?.close !== undefined,
              hasOpenDispatch
            },
            sessionId
          )
        )
        blockers.push(...snapshot.blockers)
      }
      assertConversationOriginsResolved(
        host.deps.journalDatabase.db,
        intent.conversationId,
        intent.contextGeneration
      )
      return blockers.length
        ? { kind: 'blocked', reasons: [...new Set(blockers)] }
        : { kind: 'ready' }
    }
  })
  try {
    const result = await coordinator.advance(operationKey, signal)
    if (result.kind === 'activated') {
      await runtime.continueQueued?.(operationKey)
    }
    return result
  } catch (error) {
    if (error instanceof ConversationRefusal && store.intent(operationKey)?.phase === 'cancelled') {
      return { kind: 'cancelled' }
    }
    if (error instanceof ConversationOriginUnresolvedError) {
      return { kind: 'blocked', reasons: ['unresolved-source-origin'] }
    }
    throw error
  }
}
