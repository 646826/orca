import type { StructuredConversationSwitchRuntimePorts } from './structured-conversation-switch-runtime-contracts'
import { drainConversationContinuations } from './structured-conversation-continuation'

/** Notification-driven coordinator only; drafts and idempotency remain in the existing journal. */
export function createConversationContinuationDriver(
  ports: Pick<
    StructuredConversationSwitchRuntimePorts,
    | 'db'
    | 'stateDirectory'
    | 'deliveryHost'
    | 'publishSourceQueue'
    | 'now'
    | 'reportContinuationFailure'
  >,
  signal: AbortSignal
) {
  const flights = new Map<string, Promise<void>>()
  const dirty = new Set<string>()
  const continueQueued = (operationKey: string): Promise<void> => {
    const existing = flights.get(operationKey)
    if (existing) {
      dirty.add(operationKey)
      return existing
    }
    if (signal.aborted) {
      return Promise.resolve()
    }
    const work = new Promise<void>((resolve) => setImmediate(resolve))
      .then(async () => {
        do {
          dirty.delete(operationKey)
          await drainConversationContinuations(ports, operationKey, signal)
        } while (dirty.has(operationKey) && !signal.aborted)
      })
      .catch((error: unknown) => {
        if (!signal.aborted) {
          ports.reportContinuationFailure(operationKey, error)
        }
      })
      .finally(() => {
        flights.delete(operationKey)
        dirty.delete(operationKey)
      })
    flights.set(operationKey, work)
    return work
  }
  return {
    continueQueued,
    notify(sessionId: string) {
      if (signal.aborted) {
        return
      }
      const row = ports.db
        .prepare(`SELECT i.operation_key FROM conversation_participants p
        JOIN conversations c ON c.conversation_id=p.conversation_id
        JOIN conversation_switch_intents i ON i.conversation_id=c.conversation_id
        WHERE p.session_id=? AND json_extract(i.record_json,'$.phase')='activated'
        AND json_extract(c.record_json,'$.activeSegmentId')=json_extract(i.record_json,'$.candidateSegmentId')
        AND json_extract(c.record_json,'$.pendingOperationKey') IS NULL LIMIT 1`)
        .get(sessionId)
      if (typeof row?.operation_key === 'string') {
        void continueQueued(row.operation_key)
      }
    }
  }
}
