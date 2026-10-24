import type { ConversationTransferRecoveryRequest } from '../../../shared/conversation-transfer-recovery'
import { recoverConversationTransfer } from '../conversations/conversation-transfer-recovery'
import type { StructuredConversationSwitchHost } from './structured-conversation-switch-host'

export function structuredConversationTransferRecoveryDelegate(
  host: () => StructuredConversationSwitchHost
) {
  return (
    request: ConversationTransferRecoveryRequest,
    callerKey: string,
    signal?: AbortSignal
  ) => {
    const owner = host()
    return recoverConversationTransfer({
      db: owner.deps.journalDatabase.db,
      stateDirectory: owner.deps.journalDatabase.stateDirectory,
      store: owner.deps.store.conversations,
      request,
      callerKey,
      signal,
      openJournal: async (sessionId) => (await owner.lifetime.conversation(sessionId)).journal,
      isCurrent: (journal) =>
        owner.sessions.get(journal.queuedMessages.sessionId)?.journal === journal
    })
  }
}
