import type Database from '../../sqlite/sync-database'
import { pinJournalEpoch } from './journal-epoch-pins'
import {
  readQueuedMessageEvidence,
  QueueOrderSchema,
  type QueuedMessageEvidence,
  type QueuedMessageOrder
} from './queued-message-evidence'
import { preserveLegacyQueuedMessageEvidence } from './queued-message-legacy-evidence'
export { releaseQueuedMessageEvidence } from './queued-message-evidence-retention'

export function readPinnedQueuedMessageEvidence(
  db: Database.Database,
  input: {
    ownerId: string
    sourceSessionId: string
    messageId: string
    fingerprint: string
    maxBytes?: number
  }
): QueuedMessageEvidence | null {
  const owner = db
    .prepare(
      'SELECT source_epoch,source_sequence,CASE WHEN octet_length(queue_order_json)<=16384 THEN queue_order_json END queue_order_json FROM queued_message_evidence_owners WHERE owner_id=? AND session_id=? AND message_id=? AND fingerprint=?'
    )
    .get(input.ownerId, input.sourceSessionId, input.messageId, input.fingerprint)
  if (!owner) {
    return null
  }
  const source =
    typeof owner.source_epoch === 'string' && typeof owner.source_sequence === 'number'
      ? { epoch: owner.source_epoch, sequence: owner.source_sequence }
      : null
  if (
    source &&
    !db
      .prepare(
        'SELECT 1 FROM journal_epoch_pins WHERE owner_id=? AND session_id=? AND epoch=? AND end_sequence>=?'
      )
      .get(input.ownerId, input.sourceSessionId, source.epoch, source.sequence)
  ) {
    throw new Error('queued evidence pin missing')
  }
  const evidence = readQueuedMessageEvidence(db, { ...input, source })
  return (
    evidence && {
      ...evidence,
      ...(typeof owner.queue_order_json === 'string'
        ? { queueOrder: QueueOrderSchema.parse(JSON.parse(owner.queue_order_json)) }
        : {})
    }
  )
}

export function pinQueuedMessageEvidence(
  db: Database.Database,
  input: {
    ownerId: string
    sourceSessionId: string
    messageId: string
    fingerprint: string
    queueOrder?: QueuedMessageOrder
  }
): QueuedMessageEvidence {
  if (!db.isTransaction) {
    throw new Error('queued evidence pin requires transaction')
  }
  const pinned = readPinnedQueuedMessageEvidence(db, input)
  if (pinned) {
    return pinned
  }
  let evidence = readQueuedMessageEvidence(db, input)
  if (!evidence) {
    preserveLegacyQueuedMessageEvidence(db, input.sourceSessionId, input.messageId, {
      ownerId: input.ownerId,
      expectedFingerprint: input.fingerprint
    })
    evidence = readPinnedQueuedMessageEvidence(db, input)
    if (evidence) {
      return evidence
    }
    throw new Error('queued evidence missing')
  }
  if (evidence.source) {
    pinJournalEpoch(db, {
      ownerId: input.ownerId,
      sessionId: input.sourceSessionId,
      epoch: evidence.source.epoch,
      endSequence: evidence.source.sequence
    })
  }
  db.prepare('INSERT INTO queued_message_evidence_owners VALUES(?,?,?,?,?,?,?)').run(
    input.ownerId,
    input.sourceSessionId,
    input.messageId,
    input.fingerprint,
    evidence.source?.epoch ?? null,
    evidence.source?.sequence ?? null,
    input.queueOrder ? JSON.stringify(QueueOrderSchema.parse(input.queueOrder)) : null
  )
  return { ...evidence, ...(input.queueOrder ? { queueOrder: input.queueOrder } : {}) }
}
