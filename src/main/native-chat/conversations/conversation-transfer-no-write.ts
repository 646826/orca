import type Database from '../../sqlite/sync-database'
import type { JournalOperationReceipt } from '../agent-session-journal/journal-row-writer'
import { pinJournalEpoch } from '../agent-session-journal/journal-epoch-pins'
import { conversationContextDigest } from './conversation-context-consent'
import {
  transfer,
  originalDigest,
  storedRow,
  boundedWindow,
  nativeScope,
  latestDispatch,
  matchesScope
} from './conversation-transfer-no-write-scope'
import {
  proofSchema,
  MAX_PROOF_BYTES,
  type ConversationNoUserTurnWriteReason,
  type ConversationTransferNoWriteProof,
  type HandoverScope
} from './conversation-transfer-no-write-schema'
import {
  hasExactNoWritePin,
  hasUncontradictedNoWriteHistory
} from './conversation-transfer-no-write-history'
import { sourceNativeScope } from './conversation-transfer-no-write-native'
export {
  matchesConversationTransferNoWriteIdentity,
  matchesConversationTransferNoWriteSourceIdentity
} from './conversation-transfer-no-write-native'
export { createConversationTransferNoWriteTablesSql } from './conversation-transfer-no-write-schema'
export type {
  ConversationNoUserTurnWriteReason,
  ConversationTransferNoWriteProof
} from './conversation-transfer-no-write-schema'

/** Captures the attempt at its pending commit; only a pre-write boundary may supply its reason. */
export function createConversationTransferNoWriteRecorder(input: {
  targetSessionId: string
  targetSubmissionId: string
  targetSubmissionSequence: number | undefined
  targetFingerprint: string
  runtimeFence: number
}): {
  handoverReceipt: JournalOperationReceipt
  rejectionReceipt: (reason: ConversationNoUserTurnWriteReason) => JournalOperationReceipt
} {
  let planned: HandoverScope | null = null
  let committed: HandoverScope | null = null
  return {
    handoverReceipt: {
      write(db, row) {
        planned = null
        const id = db
          .prepare(`SELECT transfer_id FROM conversation_trigger_reservations
          WHERE target_session_id=? AND target_submission_id=?`)
          .get(input.targetSessionId, input.targetSubmissionId)?.transfer_id
        if (typeof id !== 'string') {
          return
        }
        const reservation = transfer(db, id)
        const binding = reservation?.binding
        if (
          !db.isTransaction ||
          !binding ||
          reservation.state !== 'appended' ||
          row?.kind !== 'dispatch' ||
          row.state !== 'pending' ||
          row.clientMessageId !== input.targetSubmissionId ||
          row.fence !== input.runtimeFence ||
          !input.targetSubmissionSequence
        ) {
          throw new Error('Transfer handover scope unavailable')
        }
        if (!boundedWindow(db, input.targetSessionId, row.epoch, input.targetSubmissionSequence)) {
          return
        }
        const submission = storedRow(
          db,
          input.targetSessionId,
          row.epoch,
          input.targetSubmissionSequence
        )
        const previous = latestDispatch(
          db,
          input.targetSessionId,
          row.epoch,
          input.targetSubmissionId,
          input.targetSubmissionSequence,
          row.seq
        )
        const original = originalDigest(db, binding)
        const native = nativeScope(db, binding, input.runtimeFence)
        const sourceIdentity = sourceNativeScope(db, binding)
        const pendingCount = db
          .prepare(`SELECT count(*) total FROM journal_rows
          WHERE session_id=? AND epoch=? AND seq>=? AND seq<=?
            AND json_extract(row_json,'$.kind')='dispatch'
            AND json_extract(row_json,'$.clientMessageId')=?
            AND json_extract(row_json,'$.state')='pending'`)
          .get(
            input.targetSessionId,
            row.epoch,
            input.targetSubmissionSequence,
            row.seq,
            input.targetSubmissionId
          )?.total
        if (
          submission?.kind !== 'submission' ||
          submission.clientMessageId !== input.targetSubmissionId ||
          submission.payloadFingerprint !== input.targetFingerprint ||
          binding.targetFingerprint !== input.targetFingerprint ||
          submission.queuedMessageId !== undefined ||
          (previous && previous.state !== 'pending') ||
          typeof pendingCount !== 'number' ||
          pendingCount < 1
        ) {
          throw new Error('Transfer handover evidence unavailable')
        }
        if (!original || !native || !sourceIdentity || pendingCount !== 1) {
          return
        }
        planned = {
          version: 1,
          transferId: id,
          operationKey: binding.operationKey,
          bindingDigest: conversationContextDigest(binding),
          conversationId: binding.conversationId,
          contextGeneration: binding.contextGeneration,
          nativeBindingGeneration: binding.nativeBindingGeneration,
          ...native,
          targetSessionId: input.targetSessionId,
          targetSubmissionId: input.targetSubmissionId,
          targetEpoch: row.epoch,
          targetSubmissionSequence: input.targetSubmissionSequence,
          targetFingerprint: input.targetFingerprint,
          runtimeFence: input.runtimeFence,
          handoverSequence: row.seq,
          recoveryAttempt: pendingCount - 1,
          sourceSessionId: binding.queueSessionId,
          ...sourceIdentity,
          sourceMessageId: binding.messageId,
          sourceFingerprint: binding.sourceFingerprint,
          sourceOriginalDigest: original
        }
      },
      committed() {
        committed = planned
      }
    },
    rejectionReceipt: (reason) => ({
      write(db, row) {
        if (!committed) {
          return
        }
        if (
          !db.isTransaction ||
          row?.kind !== 'dispatch' ||
          row.state !== 'rejected' ||
          row.clientMessageId !== committed.targetSubmissionId ||
          row.epoch !== committed.targetEpoch ||
          row.fence !== committed.runtimeFence ||
          row.seq <= committed.handoverSequence
        ) {
          throw new Error('No-user-turn-write proof requires its rejected dispatch')
        }
        if (!matchesScope(db, committed)) {
          return
        }
        const proof = proofSchema.parse({ ...committed, rejectionSequence: row.seq, reason })
        if (
          latestDispatch(
            db,
            proof.targetSessionId,
            proof.targetEpoch,
            proof.targetSubmissionId,
            proof.targetSubmissionSequence
          )?.seq !== row.seq
        ) {
          throw new Error('No-user-turn-write dispatch changed')
        }
        db.prepare('INSERT INTO conversation_transfer_no_write VALUES(?,?,?,?,?,?,?)').run(
          proof.transferId,
          proof.recoveryAttempt,
          proof.targetSessionId,
          proof.targetSubmissionId,
          proof.targetEpoch,
          proof.rejectionSequence,
          JSON.stringify(proof)
        )
        pinJournalEpoch(db, {
          ownerId: `conversation-no-write:${proof.transferId}:${proof.recoveryAttempt}`,
          sessionId: proof.targetSessionId,
          epoch: proof.targetEpoch,
          // A pin protects its whole epoch; this anchor is retention, not attempt/source coverage.
          endSequence: 1
        })
      },
      committed() {}
    })
  }
}

/** Missing or contradictory evidence is uncertainty, never permission to send again. */
export function readConversationTransferNoWrite(
  db: Database.Database,
  transferId: string
): ConversationTransferNoWriteProof | null {
  return readProof(db, transferId, false)
}

/** Historical evidence only; recovery must separately CAS current, reconciled runtime ownership. */
export function readHistoricalConversationTransferNoWrite(
  db: Database.Database,
  transferId: string
): ConversationTransferNoWriteProof | null {
  return readProof(db, transferId, true)
}

function readProof(
  db: Database.Database,
  transferId: string,
  historical: boolean
): ConversationTransferNoWriteProof | null {
  try {
    const row = db
      .prepare(`SELECT transfer_id,recovery_attempt,target_session_id,target_submission_id,target_epoch,rejection_sequence, CASE WHEN octet_length(proof_json)<=${MAX_PROOF_BYTES}
      THEN proof_json END bounded_proof FROM conversation_transfer_no_write
      WHERE transfer_id=? ORDER BY recovery_attempt DESC LIMIT 1`)
      .get(transferId)
    if (typeof row?.bounded_proof !== 'string') {
      return null
    }
    const result = proofSchema.safeParse(JSON.parse(row.bounded_proof))
    if (!result.success) {
      return null
    }
    const proof = result.data
    if (
      proof.transferId !== transferId ||
      proof.recoveryAttempt !== row.recovery_attempt ||
      proof.targetSessionId !== row.target_session_id ||
      proof.targetSubmissionId !== row.target_submission_id ||
      proof.targetEpoch !== row.target_epoch ||
      proof.rejectionSequence !== row.rejection_sequence ||
      proof.targetSubmissionSequence >= proof.handoverSequence ||
      proof.handoverSequence >= proof.rejectionSequence ||
      !hasExactNoWritePin(db, proof) ||
      !matchesScope(db, proof, historical) ||
      (historical && !hasUncontradictedNoWriteHistory(db, proof))
    ) {
      return null
    }
    const submission = storedRow(
      db,
      proof.targetSessionId,
      proof.targetEpoch,
      proof.targetSubmissionSequence
    )
    const pending = storedRow(db, proof.targetSessionId, proof.targetEpoch, proof.handoverSequence)
    const dispatch = latestDispatch(
      db,
      proof.targetSessionId,
      proof.targetEpoch,
      proof.targetSubmissionId,
      proof.targetSubmissionSequence
    )
    return submission?.kind === 'submission' &&
      submission.clientMessageId === proof.targetSubmissionId &&
      submission.payloadFingerprint === proof.targetFingerprint &&
      submission.queuedMessageId === undefined &&
      pending?.kind === 'dispatch' &&
      pending.state === 'pending' &&
      pending.clientMessageId === proof.targetSubmissionId &&
      pending.fence === proof.runtimeFence &&
      dispatch?.state === 'rejected' &&
      dispatch.seq === proof.rejectionSequence &&
      dispatch.fence === proof.runtimeFence
      ? proof
      : null
  } catch {
    return null
  }
}
