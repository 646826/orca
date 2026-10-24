import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import type { ConversationDeliveryHost } from '../native-chat/conversations/conversation-delivery-plan'
import { createConversationDeliveryPersistence } from '../native-chat/conversations/conversation-delivery-receipt'
import type {
  ConversationDeliveryCommit,
  ConversationDeliveryEvidenceReader
} from '../native-chat/conversations/conversation-store-contracts'

/** Wiring only. Each use still verifies the durable receipt and live preparation authority. */
export function createStructuredConversationRuntimeBinding(database: JournalHostDatabase) {
  let closed = false
  let current: ReturnType<typeof createConversationDeliveryPersistence> | null = null
  const conversationDeliveryEvidence: ConversationDeliveryEvidenceReader = (db, receiptId) => {
    if (closed || db !== database.db || !current) {
      return null
    }
    return current.conversationDeliveryEvidence(db, receiptId)
  }
  const conversationDeliveryCommit: ConversationDeliveryCommit = (db, manifestId, receiptId) => {
    if (db !== database.db) {
      throw new Error('Conversation delivery database mismatch')
    }
    if (closed || !current) {
      throw new Error('Conversation delivery host unavailable')
    }
    current.conversationDeliveryCommit(db, manifestId, receiptId)
  }
  return {
    persistence: { conversationDeliveryEvidence, conversationDeliveryCommit },
    install(journalDatabase: JournalHostDatabase, host: ConversationDeliveryHost): () => void {
      if (closed) {
        throw new Error('Conversation delivery binding closed')
      }
      if (journalDatabase !== database) {
        throw new Error('Conversation delivery database mismatch')
      }
      if (current) {
        throw new Error('Conversation delivery host already installed')
      }
      const installed = createConversationDeliveryPersistence(host)
      current = installed
      return () => {
        if (current === installed) {
          current = null
        }
      }
    },
    close(): void {
      closed = true
      current = null
    }
  }
}
export type StructuredConversationRuntimeBinding = ReturnType<
  typeof createStructuredConversationRuntimeBinding
>
