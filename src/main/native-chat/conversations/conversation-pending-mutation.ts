import type Database from '../../sqlite/sync-database'
import type {
  ConversationRecord,
  ConversationSwitchIntent
} from '../../../shared/conversation-record'
import {
  ConversationClearIntentSchema,
  type ConversationClearIntent
} from '../../../shared/conversation-clear-record'
import { ConversationRefusal, readSwitchIntent } from './conversation-read-model'

export type ConversationPendingMutation =
  | { kind: 'switch'; intent: ConversationSwitchIntent }
  | { kind: 'clear'; intent: ConversationClearIntent }

export function readConversationClearIntent(
  db: Database.Database,
  key: string
): ConversationClearIntent | null {
  const row = db
    .prepare(
      'SELECT conversation_id,record_json FROM conversation_clear_intents WHERE operation_key=?'
    )
    .get(key)
  if (!row) {
    return null
  }
  try {
    const intent = ConversationClearIntentSchema.parse(
      typeof row.record_json === 'string' ? JSON.parse(row.record_json) : null
    )
    if (intent.operationKey !== key || intent.conversationId !== row.conversation_id) {
      throw new Error('Clear identity mismatch')
    }
    return intent
  } catch {
    throw new ConversationRefusal('corrupt-record')
  }
}
export function readConversationPendingMutation(
  db: Database.Database,
  conversation: ConversationRecord
): ConversationPendingMutation | null {
  const key = conversation.pendingOperationKey
  if (!key) {
    return null
  }
  const switching = readSwitchIntent(db, key)
  const clearing = readConversationClearIntent(db, key)
  if (Boolean(switching) === Boolean(clearing)) {
    throw new ConversationRefusal('corrupt-record')
  }
  if (clearing && (clearing.phase === 'committed' || clearing.phase === 'cancelled')) {
    throw new ConversationRefusal('corrupt-record')
  }
  const result: ConversationPendingMutation = switching
    ? { kind: 'switch', intent: switching }
    : { kind: 'clear', intent: clearing! }
  if (
    result.intent.conversationId !== conversation.conversationId ||
    result.intent.contextGeneration !== conversation.contextGeneration ||
    (result.kind === 'clear' && result.intent.activationFence !== conversation.activationFence)
  ) {
    throw new ConversationRefusal('stale-generation')
  }
  return result
}
