import type Database from '../../sqlite/sync-database'
import { readJournalSessionEpoch } from '../agent-session-journal/journal-row-table'
import { boundedWindow, storedRow } from './conversation-transfer-no-write-scope'
import type { ConversationTransferNoWriteProof } from './conversation-transfer-no-write-schema'

export function hasExactNoWritePin(
  db: Database.Database,
  proof: ConversationTransferNoWriteProof
): boolean {
  return (
    db
      .prepare(`SELECT end_sequence FROM journal_epoch_pins
    WHERE owner_id=? AND session_id=? AND epoch=?`)
      .get(
        `conversation-no-write:${proof.transferId}:${proof.recoveryAttempt}`,
        proof.targetSessionId,
        proof.targetEpoch
      )?.end_sequence === 1
  )
}

/** At most four bounded replacement epochs; a missing/pruned link is uncertainty. */
export function hasUncontradictedNoWriteHistory(
  db: Database.Database,
  proof: ConversationTransferNoWriteProof
): boolean {
  let epoch = readJournalSessionEpoch(db, proof.targetSessionId)
  for (let depth = 0; epoch && depth <= 4; depth++) {
    if (epoch === proof.targetEpoch) {
      return true
    }
    if (depth === 4 || !boundedWindow(db, proof.targetSessionId, epoch, 1)) {
      return false
    }
    const boundary = storedRow(db, proof.targetSessionId, epoch, 1)
    if (
      boundary?.kind !== 'epoch' ||
      !boundary.replacementOf ||
      db
        .prepare(`SELECT 1 FROM journal_rows WHERE session_id=? AND epoch=? AND seq>=1 AND seq<=4096 AND (
        (json_extract(row_json,'$.kind')='dispatch' AND json_extract(row_json,'$.clientMessageId')=?) OR
        json_extract(row_json,'$.echoOf')=? OR EXISTS(SELECT 1 FROM json_each(row_json,'$.mutations')
          WHERE json_extract(value,'$.echoOf')=?)) LIMIT 1`)
        .get(
          proof.targetSessionId,
          epoch,
          proof.targetSubmissionId,
          proof.targetSubmissionId,
          proof.targetSubmissionId
        )
    ) {
      return false
    }
    const retiredTail = db
      .prepare(
        'SELECT seq FROM journal_rows WHERE session_id=? AND epoch=? ORDER BY seq DESC LIMIT 1'
      )
      .get(proof.targetSessionId, boundary.replacementOf.epoch)?.seq
    if (retiredTail !== boundary.replacementOf.endSequence) {
      return false
    }
    epoch = boundary.replacementOf.epoch
  }
  return false
}
