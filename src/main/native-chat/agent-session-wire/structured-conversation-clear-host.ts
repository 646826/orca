import { appendConversationClearJournals } from '../conversations/conversation-clear-journals'
import { ConversationRefusal } from '../conversations/conversation-read-model'
import { reconcileConversationOrigins } from '../conversations/conversation-origin-reconciliation'
import type { StructuredConversationSwitchHost } from './structured-conversation-switch-host'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import {
  joinClosingStructuredAgentSessionChild,
  releaseLeaseOfEndedStructuredAgentSessionChild
} from './structured-agent-session-child-close'
import { readStructuredConversationQuiescence } from './structured-conversation-switch-quiescence'

type ClearHost = StructuredConversationSwitchHost & StructuredAgentSessionLifetimeContext
export type ConversationClearResult =
  | { kind: 'committed' | 'cancelled' | 'reconciliation-required' }
  | { kind: 'blocked'; reasons: string[] }

export function structuredConversationClearDelegate(host: () => ClearHost) {
  return (operationKey: string, signal: AbortSignal) => advanceClear(host(), operationKey, signal)
}

async function advanceClear(
  host: ClearHost,
  operationKey: string,
  signal: AbortSignal
): Promise<ConversationClearResult> {
  const clear = host.deps.store.conversations.clear
  const initial = clear.intent(operationKey)
  if (!initial) {
    throw new ConversationRefusal('missing-record')
  }
  let intent = initial
  if (intent.phase === 'committed' || intent.phase === 'cancelled') {
    return { kind: intent.phase }
  }
  const hasOpenDispatch = host.deps.hasOpenDispatch
  if (!hasOpenDispatch) {
    return { kind: 'blocked', reasons: ['owner-unverifiable'] }
  }
  const current = () => {
    const latest = clear.intent(operationKey)
    const conversation = host.deps.store.conversations.read(intent.conversationId)
    if (
      !latest ||
      latest.version !== intent.version ||
      conversation?.pendingOperationKey !== operationKey
    ) {
      throw new ConversationRefusal('stale-generation')
    }
  }
  const quiescence = (sessionId: string) =>
    readStructuredConversationQuiescence(
      {
        store: host.deps.store,
        sessions: host.sessions,
        adapter: host.deps.adapter,
        readChildWork: host.clientDelivery.readChildWork,
        childWorkOpen: host.clientDelivery.childWorkOpen,
        childWorkIncomplete: host.clientDelivery.childWorkIncomplete,
        starting: (id) => host.runtimeState.startFlights.has(id),
        stopping: () => false,
        hasOpenDispatch
      },
      sessionId
    )
  if (intent.phase === 'quiescing' || intent.phase === 'reconciliation-required') {
    for (const { sessionId } of [...intent.participants].sort((a, b) =>
      a.sessionId.localeCompare(b.sessionId)
    )) {
      signal.throwIfAborted()
      await host.lifetime.conversation(sessionId)
      await host.runtimeState.flushEventSink(sessionId)
      await reconcileConversationOrigins(host.deps.journalDatabase.db, sessionId, signal)
      const blockers = await host.serialize(sessionId, async () => {
        signal.throwIfAborted()
        current()
        const snapshot = quiescence(sessionId)
        // A prior clear may already have initiated this same child's close.
        const reasons = snapshot.blockers.filter(
          (reason) =>
            reason !== 'stopping' ||
            host.sessions.get(sessionId)?.child?.close?.conversationClearOperationKey !==
              operationKey
        )
        if (reasons.length) {
          return reasons
        }
        const session = host.sessions.get(sessionId)
        if (session?.child && !session.child.close) {
          session.child.close = {
            cause: 'context-clear',
            conversationClearOperationKey: operationKey,
            reason: null,
            recorded: Promise.resolve(null),
            requestedAt: session.journal.cursor()
          }
        }
        return []
      })
      if (blockers.length) {
        return { kind: 'blocked', reasons: blockers }
      }
      const stopped = await joinClosingStructuredAgentSessionChild(host, sessionId, {
        signal,
        wait: (work) => work,
        commit: (step) => host.serialize(sessionId, step)
      })
      if (!stopped.ok) {
        await clear.reconcile({ operationKey, expectedVersion: intent.version })
        return { kind: 'reconciliation-required' }
      }
      await host.serialize(sessionId, async () => {
        current()
        await releaseLeaseOfEndedStructuredAgentSessionChild(host, sessionId)
      })
      await host.runtimeState.flushEventSink(sessionId)
      await reconcileConversationOrigins(host.deps.journalDatabase.db, sessionId, signal)
    }
    signal.throwIfAborted()
    current()
    let finalBlockers: string[] = []
    try {
      intent = await clear.prepare({ operationKey, expectedVersion: intent.version }, () => {
        signal.throwIfAborted()
        current()
        finalBlockers = intent.participants.flatMap(
          ({ sessionId }) => quiescence(sessionId).blockers
        )
        if (finalBlockers.length) {
          throw new ConversationRefusal('busy')
        }
      })
    } catch (error) {
      if (finalBlockers.length) {
        return { kind: 'blocked', reasons: [...new Set(finalBlockers)] }
      }
      throw error
    }
  }
  signal.throwIfAborted()
  current()
  const conversation = host.deps.store.conversations.read(intent.conversationId)
  const active = host.deps.store.conversations
    .segments(intent.conversationId)
    .find((segment) => segment.segmentId === conversation?.activeSegmentId)
  if (!active) {
    throw new ConversationRefusal('corrupt-record')
  }
  const sessions = await Promise.all(
    intent.participants.map(async ({ sessionId }) => host.lifetime.conversation(sessionId))
  )
  const now = host.now()
  let commitBlockers: string[] = []
  try {
    await appendConversationClearJournals({
      journals: sessions.map((session) => session.journal),
      clear,
      activeSessionId: active.sessionId,
      operationKey,
      expectedVersion: intent.version,
      now,
      signal,
      isCurrent: (journal) =>
        host.sessions.get(journal.queuedMessages.sessionId)?.journal === journal,
      validate: () => {
        current()
        commitBlockers = intent.participants.flatMap(
          ({ sessionId }) => quiescence(sessionId).blockers
        )
        if (commitBlockers.length) {
          throw new ConversationRefusal('busy')
        }
      }
    })
  } catch (error) {
    if (
      commitBlockers.length ||
      (error instanceof ConversationRefusal && error.reason === 'stale-source')
    ) {
      await clear.reconcile({ operationKey, expectedVersion: intent.version })
      return commitBlockers.length
        ? { kind: 'blocked', reasons: [...new Set(commitBlockers)] }
        : { kind: 'reconciliation-required' }
    }
    throw error
  }
  return { kind: 'committed' }
}
