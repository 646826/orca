import { refreshVerifiedConversationManifestIndex } from './conversation-delivery-reauthorization'
import type Database from '../../sqlite/sync-database'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { runJournalTransaction } from '../agent-session-journal/journal-transaction'
import {
  readConversationDeliveryBinding,
  assertConversationReservedDelivery,
  assertConversationDeliveryCursor
} from './conversation-delivery-binding'
import { readConversation } from './conversation-read-model'
import { readConversationOrigin } from './conversation-origin'
import {
  verifyConversationContextEvidence,
  assertConversationManifestAuthority
} from './conversation-context-authority'
import {
  conversationDeliveryEnvelope,
  type ConversationDeliveryHost
} from './conversation-delivery-plan'
import {
  verifyConversationNativeInput,
  type ConversationNativeInputObservation
} from './conversation-delivery-transport'

export function bindConversationNativeInput(
  db: Database.Database,
  input: {
    planId: string
    submissionId: string
    observation: ConversationNativeInputObservation
  },
  host: ConversationDeliveryHost
): void {
  if (db.isTransaction) {
    throw new Error('Native input verification must run outside a writer transaction')
  }
  const { plan, manifest, intent, journal } = readConversationDeliveryBinding(
    db,
    input.planId,
    host
  )
  if (
    intent.phase !== 'delivering' ||
    readConversation(db, intent.conversationId)?.pendingOperationKey !== intent.operationKey ||
    intent.version !== plan.intentVersion + 1
  ) {
    throw new Error('Delivery input requires the pending dispatch claim')
  }
  assertConversationReservedDelivery(db, input.planId, input.submissionId, host)
  const submission = journal.submission(input.submissionId)
  const body = journal.itemBody(agentJournalSubmissionKey(input.submissionId))
  const origin = readConversationOrigin(
    db,
    plan.targetSessionId,
    { kind: 'submission', id: input.submissionId },
    plan.nativeBindingGeneration
  )
  if (
    !submission ||
    submission.fence !== plan.runtimeFence ||
    submission.dispatchState !== 'pending' ||
    !body ||
    body.kind !== 'message' ||
    body.role !== 'user' ||
    body.command ||
    !origin ||
    origin.segmentId !== intent.candidateSegmentId ||
    origin.contextGeneration !== plan.contextGeneration ||
    origin.nativeBindingGeneration !== plan.nativeBindingGeneration
  ) {
    throw new Error('Native input is not the candidate submission')
  }
  const expectedText = conversationDeliveryEnvelope(manifest, plan.inlineDeltaKeys)
  const textBlocks = body.blocks.filter((block) => block.type === 'text').map((block) => block.text)
  if (
    textBlocks.filter((text) => text === expectedText).length !== 1 ||
    body.blocks.some((block) => block.type !== 'text')
  ) {
    throw new Error('Candidate input needs a verified attachment mapping or exact envelope')
  }
  if (input.observation.transport !== plan.transport) {
    throw new Error('Native transport changed')
  }
  const proof = verifyConversationNativeInput({
    ...input.observation,
    expectedText,
    expectedModel: manifest.target.model,
    nativeSessionId: plan.nativeSessionId,
    expectedAttachments: [],
    expectedAdditionalText: textBlocks.filter((text) => text !== expectedText)
  })
  if (proof.textDigest !== plan.envelopeDigest) {
    throw new Error('Prepared envelope changed')
  }
  if (
    !host.readPreDispatchPreparationEvidence &&
    db
      .prepare(
        "SELECT 1 FROM conversation_preparation_previews WHERE manifest_id=? AND json_type(target_json,'$.workspaceObservation')='object'"
      )
      .get(manifest.manifestId)
  ) {
    throw new Error('Strict workspace preparation proof is required before native input')
  }
  verifyConversationContextEvidence(
    db,
    manifest,
    host.readPreDispatchPreparationEvidence ?? host.readPreparationEvidence
  )
  assertConversationManifestAuthority(db, manifest)
  const cursor = journal.cursor()
  runJournalTransaction(db, () => {
    assertConversationDeliveryCursor(db, plan.targetSessionId, cursor.epoch, cursor.sequence)
    const existing = db
      .prepare('SELECT * FROM conversation_delivery_inputs WHERE plan_id=?')
      .get(plan.planId)
    if (existing) {
      if (
        existing.submission_id !== input.submissionId ||
        existing.payload_digest !== proof.payloadDigest ||
        existing.payload_fingerprint !== submission.payloadFingerprint
      ) {
        throw new Error('Native input cannot be rebound')
      }
      throw new Error('Native input already observed; reconcile before replay')
    }
    db.prepare('INSERT INTO conversation_delivery_inputs VALUES(?,?,?,?,?,?,?)').run(
      plan.planId,
      input.submissionId,
      submission.payloadFingerprint,
      proof.payloadDigest,
      proof.attachmentsDigest,
      cursor.epoch,
      cursor.sequence
    )
  })
}

export async function observeConversationNativeInput(
  db: Database.Database,
  input: Parameters<typeof bindConversationNativeInput>[1],
  host: ConversationDeliveryHost,
  signal: AbortSignal
): Promise<void> {
  const { plan } = readConversationDeliveryBinding(db, input.planId, host)
  await refreshVerifiedConversationManifestIndex(
    db,
    plan.manifestId,
    host.readPreparationEvidence,
    signal
  )
  bindConversationNativeInput(db, input, host)
}
