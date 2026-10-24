import type Database from '../../sqlite/sync-database'
import type { AgentSessionStoreState } from '../../runtime/agent-session-store-state'
import { settleAgentSessionOperationInto } from '../../runtime/agent-session-operation-admission'
import type {
  ConversationSegment,
  ConversationActivationResult
} from '../../../shared/conversation-record'
import type { ConversationActivationRequest } from '../../../shared/conversation-wire'
import type {
  ConversationDeliveryEvidenceReader,
  ConversationDeliveryCommit
} from './conversation-store'
import { pinJournalEpoch } from '../agent-session-journal/journal-epoch-pins'
import { registerConversationSourceSpan } from './conversation-source-attribution'
import {
  ConversationRefusal,
  readParticipant,
  readSegments,
  readSourceBoundary,
  readParticipantSourceBoundaries
} from './conversation-read-model'
import {
  requireRecord,
  requireConversation,
  requireIntent,
  validateIdentity,
  assertGeneration,
  assertIntent,
  assertSources,
  writeConversation,
  writeParticipant,
  writeSegment,
  writeIntent
} from './conversation-store-transitions'

export function activateConversation(
  db: Database.Database,
  state: AgentSessionStoreState,
  request: ConversationActivationRequest,
  deliveryEvidence: ConversationDeliveryEvidenceReader,
  deliveryCommit?: ConversationDeliveryCommit
): ConversationActivationResult {
  const intent = requireIntent(db, request.operationKey)
  const conversation = requireConversation(db, intent.conversationId)
  assertGeneration(conversation, request)
  assertIntent(conversation, intent, request.expectedVersion)
  if (
    intent.phase !== 'delivering' ||
    !intent.manifestId ||
    intent.deliveryReceiptId !== request.deliveryReceiptId ||
    !request.deliveryReceiptId
  ) {
    throw new ConversationRefusal('invalid-phase')
  }
  const evidence = deliveryEvidence(db, request.deliveryReceiptId)
  if (
    !evidence ||
    evidence.deliveryReceiptId !== request.deliveryReceiptId ||
    evidence.operationKey !== intent.operationKey ||
    evidence.manifestId !== intent.manifestId ||
    evidence.targetSessionId !== intent.targetSessionId ||
    evidence.contextGeneration !== intent.contextGeneration ||
    evidence.activationFence !== intent.activationFence ||
    evidence.nativeBindingGeneration !== intent.nativeBindingGeneration ||
    JSON.stringify(evidence.sourceBoundaries) !== JSON.stringify(intent.sourceBoundaries) ||
    JSON.stringify(evidence.candidateBoundary) !== JSON.stringify(intent.candidateBoundary) ||
    JSON.stringify(evidence.candidateBaseline) !== JSON.stringify(intent.candidateBaseline) ||
    JSON.stringify(evidence.candidateReadback) !==
      JSON.stringify(readParticipantSourceBoundaries(db, intent.targetSessionId))
  ) {
    throw new ConversationRefusal('unverified-delivery')
  }
  if (
    JSON.stringify(readSourceBoundary(db, intent.targetSessionId)) !==
    JSON.stringify(intent.candidateBoundary)
  ) {
    throw new ConversationRefusal('stale-source')
  }
  const member = readParticipant(db, intent.targetSessionId)
  if (!member) {
    throw new ConversationRefusal('missing-record')
  }
  validateIdentity(member, requireRecord(state, member.sessionId))
  if (
    member.nativeBindingGeneration !== request.expectedNativeBindingGeneration ||
    member.nativeBindingGeneration !== intent.nativeBindingGeneration ||
    member.contextGeneration !== conversation.contextGeneration
  ) {
    throw new ConversationRefusal('stale-generation')
  }
  assertSources(db, intent, request.sourceBoundaries)
  if (JSON.stringify(intent.sourceBoundaries) !== JSON.stringify(request.sourceBoundaries)) {
    throw new ConversationRefusal('stale-source')
  }
  if (!deliveryCommit) {
    throw new ConversationRefusal('unverified-delivery')
  }
  const coverageCommit: unknown = deliveryCommit(db, intent.manifestId, request.deliveryReceiptId)
  if (coverageCommit instanceof Promise) {
    throw new Error('Delivery coverage commit must be synchronous')
  }
  const segments = readSegments(db, conversation.conversationId)
  const active = segments.find((s) => s.segmentId === conversation.activeSegmentId)
  if (!active) {
    throw new ConversationRefusal('corrupt-record')
  }
  const source = request.sourceBoundaries.find(
    (b) =>
      b.sessionId === active.sessionId && b.epoch === readSourceBoundary(db, active.sessionId).epoch
  )
  if (!source) {
    throw new ConversationRefusal('stale-source')
  }
  const previous = readParticipant(db, active.sessionId)
  if (!previous) {
    throw new ConversationRefusal('corrupt-record')
  }
  validateIdentity(previous, requireRecord(state, previous.sessionId))
  pinJournalEpoch(db, { ownerId: `conversation-segment:${active.segmentId}:sealed`, ...source })
  writeSegment(db, { ...active, boundary: source })
  registerConversationSourceSpan(
    db,
    active,
    source,
    source.epoch === active.boundary.epoch ? active.startSequence : 1
  )
  writeParticipant(db, { ...previous, state: 'parked' })
  writeParticipant(db, { ...member, state: 'active' })
  const boundary = readSourceBoundary(db, member.sessionId)
  const candidate = segments.find((s) => s.segmentId === intent.candidateSegmentId)
  if (
    !candidate ||
    candidate.lifecycle !== 'candidate' ||
    candidate.sessionId !== member.sessionId ||
    candidate.activationFence !== intent.activationFence ||
    candidate.contextGeneration !== intent.contextGeneration ||
    candidate.nativeBindingGeneration !== member.nativeBindingGeneration
  ) {
    throw new ConversationRefusal('invalid-phase')
  }
  const segment: ConversationSegment = { ...candidate, lifecycle: 'activated', boundary }
  writeSegment(db, segment)
  registerConversationSourceSpan(db, segment, boundary, segment.startSequence)
  pinJournalEpoch(db, {
    ownerId: `conversation-segment:${segment.segmentId}:initial`,
    ...boundary
  })
  writeConversation(db, {
    ...conversation,
    revision: conversation.revision + 1,
    activationFence: intent.activationFence,
    activeSegmentId: segment.segmentId,
    pendingOperationKey: null
  })
  writeIntent(db, { ...intent, phase: 'activated', version: intent.version + 1 })
  const result = {
    conversationId: conversation.conversationId,
    segmentId: segment.segmentId,
    contextGeneration: conversation.contextGeneration,
    activationFence: intent.activationFence
  }
  const ledger = state.operations.get(intent.operationKey)
  if (!ledger) {
    throw new ConversationRefusal('expired-intent')
  }
  settleAgentSessionOperationInto(state, {
    callerKey: ledger.callerKey,
    operationId: ledger.operationId,
    outcome: {
      status: 'succeeded',
      sessionId: member.sessionId,
      conversationActivation: result
    }
  })
  return result
}
