import { refreshVerifiedConversationManifestIndex } from './conversation-delivery-reauthorization'
import { recordConversationCoverage } from './conversation-context-coverage'
import {
  readConversationDeliveryBinding,
  assertConversationReservedDelivery,
  assertConversationDeliveryCursor
} from './conversation-delivery-binding'
import { verifyConversationCandidateReadback } from './conversation-delivery-readback'
import { randomUUID } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import {
  isConversationDeliveryEvidence,
  type ConversationDeliveryEvidence
} from '../../../shared/conversation-wire'
import { runJournalTransaction } from '../agent-session-journal/journal-transaction'
import { conversationContextDigest } from './conversation-context-consent'
import {
  readConversationCoverageRevision,
  assertConversationCoverageRevision,
  readConversationAuthorityRevision,
  assertConversationAuthorityRevision
} from './conversation-context-authority-revision'
import {
  readParticipantSourceBoundaries,
  readConversationDeliverySources
} from './conversation-read-model'
import { readConversationOrigin } from './conversation-origin'
import {
  verifyConversationContextEvidence,
  assertConversationManifestAuthority
} from './conversation-context-authority'
import {
  inspectConversationDeliveryAssignments,
  type ConversationDeliveryHost
} from './conversation-delivery-plan'

export {
  bindConversationNativeInput,
  observeConversationNativeInput
} from './conversation-delivery-input'

export async function finalizeConversationDeliveryReceipt(
  db: Database.Database,
  planId: string,
  host: ConversationDeliveryHost,
  signal: AbortSignal
): Promise<ConversationDeliveryEvidence | null> {
  if (db.isTransaction) {
    throw new Error('Delivery verification cannot run under a writer transaction')
  }
  const initial = readConversationDeliveryBinding(db, planId, host)
  await refreshVerifiedConversationManifestIndex(
    db,
    initial.plan.manifestId,
    host.readPreparationEvidence,
    signal
  )
  const { plan, manifest, intent, journal } = readConversationDeliveryBinding(db, planId, host)
  const input = db.prepare('SELECT * FROM conversation_delivery_inputs WHERE plan_id=?').get(planId)
  if (!input || typeof input.submission_id !== 'string') {
    return null
  }
  assertConversationReservedDelivery(db, planId, input.submission_id, host)
  const submission = journal.submission(input.submission_id)
  const accepted = journal.receiptFor(input.submission_id)
  if (
    !submission ||
    submission.dispatchState !== 'accepted' ||
    !submission.providerItemId ||
    submission.recovered ||
    submission.fence !== plan.runtimeFence ||
    submission.payloadFingerprint !== input.payload_fingerprint ||
    !accepted ||
    accepted.originCorrelation !== 'exact' ||
    accepted.providerItemId !== submission.providerItemId
  ) {
    return null
  }
  const origin = readConversationOrigin(
    db,
    plan.targetSessionId,
    { kind: 'submission', id: input.submission_id },
    plan.nativeBindingGeneration
  )
  if (
    !origin ||
    origin.segmentId !== intent.candidateSegmentId ||
    origin.contextGeneration !== plan.contextGeneration ||
    origin.nativeBindingGeneration !== plan.nativeBindingGeneration
  ) {
    return null
  }
  const authorityRevision = readConversationAuthorityRevision(db)
  const coverageRevision = readConversationCoverageRevision(db)
  const candidateReadback = readParticipantSourceBoundaries(db, plan.targetSessionId)
  if (!(await verifyConversationCandidateReadback(db, intent, candidateReadback, signal))) {
    return null
  }
  const assignments = await inspectConversationDeliveryAssignments(db, manifest, host, signal)
  if (assignments.assignmentDigest !== plan.assignmentDigest) {
    return null
  }
  signal.throwIfAborted()
  const cursor = journal.cursor()
  if (cursor.epoch !== input.epoch) {
    return null
  }
  const evidence: ConversationDeliveryEvidence = {
    deliveryReceiptId: randomUUID(),
    operationKey: plan.operationKey,
    manifestId: plan.manifestId,
    targetSessionId: plan.targetSessionId,
    contextGeneration: plan.contextGeneration,
    activationFence: intent.activationFence,
    nativeBindingGeneration: plan.nativeBindingGeneration,
    sourceBoundaries: readConversationDeliverySources(
      db,
      intent.conversationId,
      plan.targetSessionId
    ),
    candidateBoundary: {
      sessionId: plan.targetSessionId,
      epoch: cursor.epoch,
      endSequence: cursor.sequence
    },
    candidateBaseline: intent.candidateBaseline,
    candidateReadback
  }
  if (
    conversationContextDigest(evidence.sourceBoundaries) !==
    conversationContextDigest(intent.sourceBoundaries)
  ) {
    return null
  }
  runJournalTransaction(db, () => {
    assertConversationAuthorityRevision(db, authorityRevision)
    assertConversationCoverageRevision(db, coverageRevision)
    assertConversationDeliveryCursor(db, plan.targetSessionId, cursor.epoch, cursor.sequence)
    if (
      conversationContextDigest(readParticipantSourceBoundaries(db, plan.targetSessionId)) !==
      conversationContextDigest(candidateReadback)
    ) {
      throw new Error('Candidate readback changed')
    }
    readConversationDeliveryBinding(db, planId, host)
    verifyConversationContextEvidence(db, manifest, host.readPreparationEvidence)
    assertConversationManifestAuthority(db, manifest)
    db.prepare('INSERT INTO conversation_delivery_receipts VALUES(?,?,?,?,?)').run(
      evidence.deliveryReceiptId,
      planId,
      authorityRevision,
      coverageRevision,
      JSON.stringify(evidence)
    )
  })
  return evidence
}

export function readConversationDeliveryReceipt(
  db: Database.Database,
  receiptId: string,
  host: ConversationDeliveryHost
): ConversationDeliveryEvidence | null {
  const row = db
    .prepare('SELECT * FROM conversation_delivery_receipts WHERE receipt_id=?')
    .get(receiptId)
  if (
    !row ||
    typeof row.plan_id !== 'string' ||
    typeof row.evidence_json !== 'string' ||
    row.authority_revision !== readConversationAuthorityRevision(db) ||
    row.coverage_revision !== readConversationCoverageRevision(db)
  ) {
    return null
  }
  const evidence: unknown = JSON.parse(row.evidence_json)
  if (!isConversationDeliveryEvidence(evidence)) {
    return null
  }
  try {
    const { plan, manifest } = readConversationDeliveryBinding(db, row.plan_id, host)
    verifyConversationContextEvidence(db, manifest, host.readPreparationEvidence)
    assertConversationDeliveryCursor(
      db,
      plan.targetSessionId,
      evidence.candidateBoundary.epoch,
      evidence.candidateBoundary.endSequence
    )
    return evidence
  } catch {
    return null
  }
}

/** Install the pair together: coverage joins commit before activation changes source authority. */
export function createConversationDeliveryPersistence(host: ConversationDeliveryHost) {
  const conversationDeliveryEvidence = (db: Database.Database, receiptId: string) =>
    readConversationDeliveryReceipt(db, receiptId, host)
  return {
    conversationDeliveryEvidence,
    conversationDeliveryCommit: (
      db: Database.Database,
      manifestId: string,
      receiptId: string
    ): void => {
      recordConversationCoverage(
        db,
        manifestId,
        receiptId,
        conversationDeliveryEvidence,
        host.readPreparationEvidence
      )
    }
  }
}
