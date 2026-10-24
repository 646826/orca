import type Database from '../../sqlite/sync-database'
import type { AgentSessionStoreState } from '../../runtime/agent-session-store-state'
import { settleAgentSessionOperationInto } from '../../runtime/agent-session-operation-admission'
import type { ConversationCancellationRequest } from '../../../shared/conversation-wire'
import type { ConversationSwitchIntent } from '../../../shared/conversation-record'
import { ConversationRefusal } from './conversation-read-model'
import {
  requireIntent,
  requireConversation,
  assertGeneration,
  assertIntent,
  writeIntent,
  writeConversation
} from './conversation-store-transitions'

/** A prepared cancellation races the same transaction/CAS as the dispatch claim. */
export function cancelConversationSwitch(
  db: Database.Database,
  state: AgentSessionStoreState,
  request: ConversationCancellationRequest
): ConversationSwitchIntent {
  const intent = requireIntent(db, request.operationKey)
  const conversation = requireConversation(db, intent.conversationId)
  assertGeneration(conversation, request)
  assertIntent(conversation, intent, request.expectedVersion)
  const effect = db
    .prepare(`SELECT 1 FROM conversation_trigger_reservations
    WHERE operation_key=? AND state NOT IN ('reserved','cancelled')
    UNION ALL SELECT 1 FROM conversation_delivery_inputs i JOIN conversation_delivery_plans p ON p.plan_id=i.plan_id WHERE p.operation_key=? LIMIT 1`)
    .get(intent.operationKey, intent.operationKey)
  if (!['quiescing', 'prepared'].includes(intent.phase) || effect) {
    if (intent.phase === 'activated' || intent.phase === 'cancelled') {
      throw new ConversationRefusal('invalid-phase')
    }
    const uncertain: ConversationSwitchIntent = {
      ...intent,
      phase: 'reconciliation-required',
      version: intent.version + 1
    }
    writeIntent(db, uncertain)
    return uncertain
  }
  const ledger = state.operations.get(intent.operationKey)
  if (!ledger) {
    throw new ConversationRefusal('expired-intent')
  }
  db.prepare(
    "UPDATE conversation_trigger_reservations SET state='cancelled' WHERE operation_key=? AND state='reserved'"
  ).run(intent.operationKey)
  const cancelled: ConversationSwitchIntent = {
    ...intent,
    phase: 'cancelled',
    version: intent.version + 1
  }
  writeIntent(db, cancelled)
  writeConversation(db, {
    ...conversation,
    revision: conversation.revision + 1,
    pendingOperationKey: null
  })
  settleAgentSessionOperationInto(state, {
    callerKey: ledger.callerKey,
    operationId: ledger.operationId,
    outcome: { status: 'failed', code: 'conversationSwitchCancelled' }
  })
  // Preserve queue rows, claims, candidate evidence and transfer identities. This only removes admission freeze.
  return cancelled
}

export function markConversationReconciliation(
  db: Database.Database,
  operationKey: string,
  expectedVersion: number
): ConversationSwitchIntent {
  const intent = requireIntent(db, operationKey)
  assertIntent(requireConversation(db, intent.conversationId), intent, expectedVersion)
  if (intent.phase === 'activated' || intent.phase === 'cancelled') {
    throw new ConversationRefusal('invalid-phase')
  }
  const result: ConversationSwitchIntent = {
    ...intent,
    phase: 'reconciliation-required',
    version: intent.version + 1
  }
  writeIntent(db, result)
  return result
}
