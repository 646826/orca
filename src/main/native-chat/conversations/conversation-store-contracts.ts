import type Database from '../../sqlite/sync-database'
import type { ConversationDeliveryEvidence } from '../../../shared/conversation-wire'

/** Verifies the whole manifest plan (prior coverage + accepted delta + live retrieval) and reserved candidate rows; partial/admitted receipts return null. */
export type ConversationDeliveryEvidenceReader = (
  db: Database.Database,
  receiptId: string
) => ConversationDeliveryEvidence | null

export type ConversationDeliveryCommit = (
  db: Database.Database,
  manifestId: string,
  receiptId: string
) => void
