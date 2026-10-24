import { z } from 'zod'

const text = z.string().min(1).max(2048)
const sequence = z.number().int().positive().safe()
const generation = z.number().int().nonnegative().safe()
const reasonSchema = z.enum(['aborted-before-call', 'pre-dispatch-refusal', 'pre-write-abort'])
export type ConversationNoUserTurnWriteReason = z.infer<typeof reasonSchema>
export const proofSchema = z
  .object({
    version: z.literal(1),
    transferId: text,
    operationKey: text,
    bindingDigest: text,
    conversationId: text,
    contextGeneration: sequence,
    nativeBindingGeneration: sequence,
    nativeIdentityDigest: text,
    recordBirthDigest: text,
    accountBindingDigest: text,
    nativeHandleDigest: text,
    targetSessionId: text,
    targetSubmissionId: text,
    targetEpoch: text,
    targetSubmissionSequence: sequence,
    targetFingerprint: text,
    runtimeFence: generation,
    handoverSequence: sequence,
    recoveryAttempt: generation,
    sourceSessionId: text,
    sourceNativeBindingGeneration: sequence,
    sourceRecordBirthDigest: text,
    sourceAccountBindingDigest: text,
    sourceNativeHandleDigest: text,
    sourceMessageId: text,
    sourceFingerprint: text,
    sourceOriginalDigest: text,
    rejectionSequence: sequence,
    reason: reasonSchema
  })
  .strict()
export type ConversationTransferNoWriteProof = z.infer<typeof proofSchema>
export type HandoverScope = Omit<ConversationTransferNoWriteProof, 'rejectionSequence' | 'reason'>
export const MAX_PROOF_BYTES = 32 * 1024
export const MAX_SCOPE_ROWS = 4096
export const MAX_SCOPE_BYTES = 8 * 1024 * 1024
export const MAX_ROW_BYTES = 1024 * 1024

export function createConversationTransferNoWriteTablesSql(): string {
  return `CREATE INDEX IF NOT EXISTS conversation_no_write_receipt_plan ON conversation_delivery_receipts(plan_id);
    CREATE TABLE IF NOT EXISTS conversation_transfer_no_write (
    transfer_id TEXT NOT NULL REFERENCES conversation_trigger_reservations(transfer_id),
    recovery_attempt INTEGER NOT NULL CHECK(recovery_attempt>=0),
    target_session_id TEXT NOT NULL,target_submission_id TEXT NOT NULL,
    target_epoch TEXT NOT NULL,rejection_sequence INTEGER NOT NULL,
    proof_json TEXT NOT NULL CHECK(octet_length(proof_json)<=${MAX_PROOF_BYTES}),
    PRIMARY KEY(transfer_id,recovery_attempt),
    UNIQUE(target_session_id,target_submission_id,target_epoch,rejection_sequence));
    CREATE TRIGGER IF NOT EXISTS conversation_transfer_no_write_immutable
    BEFORE UPDATE ON conversation_transfer_no_write
    BEGIN SELECT RAISE(ABORT,'no-user-turn-write proof is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS conversation_transfer_no_write_no_replace
    BEFORE INSERT ON conversation_transfer_no_write
    WHEN EXISTS(SELECT 1 FROM conversation_transfer_no_write
      WHERE transfer_id=NEW.transfer_id AND recovery_attempt=NEW.recovery_attempt)
    BEGIN SELECT RAISE(ABORT,'no-user-turn-write proof cannot be replaced'); END;`
}
