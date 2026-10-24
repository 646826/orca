import type { ConversationSwitchIntent } from '../../../shared/conversation-record'
import type { ConversationStore } from './conversation-store'
import type { ConversationSwitchResult } from './conversation-switch-contracts'

export async function requireConversationSwitchReconciliation(
  store: ConversationStore,
  intent: ConversationSwitchIntent
): Promise<ConversationSwitchResult> {
  if (intent.phase !== 'reconciliation-required') {
    await store.markReconciliation(intent.operationKey, intent.version)
  }
  return { kind: 'reconciliation-required' }
}

export function conversationSwitchNeedsReconciliation(intent: ConversationSwitchIntent): boolean {
  return intent.phase === 'delivering' || intent.phase === 'reconciliation-required'
}
