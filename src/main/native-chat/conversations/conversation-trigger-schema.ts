import type Database from '../../sqlite/sync-database'
import { z } from 'zod'
const text = z.string().min(1)
const positive = z.number().int().positive()
export const conversationTriggerBindingSchema = z
  .object({
    transferId: text,
    kind: z.enum(['trigger', 'queued-continuation']),
    targetOptionsDigest: text,
    operationKey: text,
    conversationId: text,
    contextGeneration: positive,
    candidateGeneration: positive,
    candidateSegmentId: text,
    nativeBindingGeneration: positive,
    queueSessionId: text,
    messageId: text,
    sourceFingerprint: text,
    expectedQueueState: z.enum(['waiting', 'returned']),
    targetSessionId: text,
    targetSubmissionId: text,
    targetFingerprint: text,
    deliveryPlanId: text,
    manifestId: text,
    manifestDigest: text,
    attachmentClaimsDigest: text
  })
  .strict()
export type ConversationTriggerBinding = z.infer<typeof conversationTriggerBindingSchema>
export const conversationTriggerStateSchema = z.enum([
  'reserved',
  'cancelled',
  'converting',
  'appended',
  'uncertain',
  'accepted',
  'proven-no-effect'
])
export type ConversationTriggerReservation = {
  binding: ConversationTriggerBinding
  state: z.infer<typeof conversationTriggerStateSchema>
}
export function createConversationTriggerTablesSql(): string {
  return `CREATE TABLE IF NOT EXISTS conversation_trigger_reservations (
    transfer_id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('trigger','queued-continuation')),operation_key TEXT NOT NULL REFERENCES conversation_switch_intents(operation_key),
    queue_session_id TEXT NOT NULL,message_id TEXT NOT NULL,
    target_session_id TEXT NOT NULL,target_submission_id TEXT NOT NULL,
    binding_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('reserved','cancelled','converting','appended','uncertain','accepted','proven-no-effect')),
    UNIQUE(target_session_id,target_submission_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS conversation_reserved_source ON conversation_trigger_reservations(queue_session_id,message_id) WHERE state!='cancelled';
  CREATE UNIQUE INDEX IF NOT EXISTS conversation_single_trigger ON conversation_trigger_reservations(operation_key) WHERE kind='trigger';
  `
}

/** Reservations outlive legacy SQL cards; journal mutation admission enforces exclusivity. */
export function migrateConversationTriggerReservations(db: Database.Database): void {
  if (!db.isTransaction) {
    throw new Error('trigger migration requires transaction')
  }
  const legacy = db
    .prepare('PRAGMA foreign_key_list(conversation_trigger_reservations)')
    .all()
    .some((foreignKey) => foreignKey.table === 'queued_messages')
  db.exec('DROP TRIGGER IF EXISTS conversation_trigger_queue_protected')
  if (legacy) {
    db.exec(`DROP INDEX IF EXISTS conversation_reserved_source;
      DROP INDEX IF EXISTS conversation_single_trigger;
      ALTER TABLE conversation_trigger_reservations RENAME TO conversation_trigger_reservations_legacy;`)
    db.exec(createConversationTriggerTablesSql())
    db.exec(`INSERT INTO conversation_trigger_reservations SELECT * FROM conversation_trigger_reservations_legacy;
      DROP TABLE conversation_trigger_reservations_legacy;`)
  } else {
    db.exec(createConversationTriggerTablesSql())
  }
}
