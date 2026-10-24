import { readConversationTrigger } from './conversation-trigger-reservation'
import { readPinnedQueuedMessageEvidence } from '../agent-session-journal/queued-message-origin'
import type Database from '../../sqlite/sync-database'
import { readConversationManifest } from './conversation-context-coverage'
import { readSwitchIntent, readSourceBoundary } from './conversation-read-model'
import {
  conversationDeliveryNativeIdentity,
  readConversationDeliveryPlan,
  type ConversationDeliveryHost
} from './conversation-delivery-plan'

export function readConversationDeliveryBinding(
  db: Database.Database,
  planId: string,
  host: ConversationDeliveryHost
) {
  const plan = readConversationDeliveryPlan(db, planId)
  const manifest = plan && readConversationManifest(db, plan.manifestId)
  const intent = plan && readSwitchIntent(db, plan.operationKey)
  const journal = plan && host.getJournal(plan.targetSessionId)
  if (
    !plan ||
    !manifest ||
    !intent ||
    !journal ||
    !intent.candidateSegmentId ||
    intent.contextGeneration !== plan.contextGeneration ||
    intent.nativeBindingGeneration !== plan.nativeBindingGeneration ||
    intent.manifestId !== plan.manifestId
  ) {
    throw new Error('Delivery plan is unavailable or stale')
  }
  const native = conversationDeliveryNativeIdentity(host, manifest)
  if (
    native.nativeIdentityDigest !== plan.nativeIdentityDigest ||
    native.runtimeFence !== plan.runtimeFence ||
    native.nativeSessionId !== plan.nativeSessionId ||
    native.transport !== plan.transport
  ) {
    throw new Error('Native delivery binding changed')
  }
  return { plan, manifest, intent, journal }
}
export function assertConversationDeliveryCursor(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  sequence: number
): void {
  const actual = readSourceBoundary(db, sessionId)
  if (actual.epoch !== epoch || actual.endSequence !== sequence) {
    throw new Error('Native journal changed during verification')
  }
}

export function assertConversationReservedDelivery(
  db: Database.Database,
  planId: string,
  submissionId: string,
  host: ConversationDeliveryHost
): void {
  const { plan, intent, journal } = readConversationDeliveryBinding(db, planId, host)
  const reservation = readConversationTrigger(db, intent.operationKey)
  const binding = reservation?.binding
  const draft =
    binding &&
    readPinnedQueuedMessageEvidence(db, {
      ownerId: `conversation-transfer:${binding.transferId}`,
      sourceSessionId: binding.queueSessionId,
      messageId: binding.messageId,
      fingerprint: binding.sourceFingerprint
    })
  const submission = journal.submission(submissionId)
  if (
    !binding ||
    !reservation ||
    !['appended', 'uncertain', 'accepted'].includes(reservation.state) ||
    binding.deliveryPlanId !== plan.planId ||
    binding.targetSubmissionId !== submissionId ||
    binding.targetSessionId !== plan.targetSessionId ||
    binding.manifestDigest !== plan.manifestDigest ||
    binding.candidateSegmentId !== intent.candidateSegmentId ||
    binding.contextGeneration !== plan.contextGeneration ||
    binding.nativeBindingGeneration !== plan.nativeBindingGeneration ||
    submission?.payloadFingerprint !== binding.targetFingerprint ||
    submission.queuedMessageId !== undefined ||
    draft?.fingerprint !== binding.sourceFingerprint
  ) {
    throw new Error('Candidate submission is not the reserved delivery')
  }
}
