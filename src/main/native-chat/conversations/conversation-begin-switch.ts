import type Database from '../../sqlite/sync-database'
import type { AgentSessionStoreState } from '../../runtime/agent-session-store-state'
import { foundAgentSessionInto } from '../../runtime/agent-session-founding-admission'
import type { AgentSessionReserveRequest } from '../../runtime/agent-session-reservation-admission'
import {
  admitAndClaimAgentSessionOperationInto,
  type AgentSessionOperationAdmission
} from '../../runtime/agent-session-operation-admission'
import { agentSessionOperationKey } from '../../../shared/agent-session-operation-ledger'
import type { ConversationSwitchRequest } from '../../../shared/conversation-wire'
import type { ConversationSwitchIntent } from '../../../shared/conversation-record'
import { reserveConversationCandidateSegment } from './conversation-candidate-segment'
import { pinJournalEpoch } from '../agent-session-journal/journal-epoch-pins'
import {
  ConversationRefusal,
  readSwitchIntent,
  readParticipant,
  readSegments,
  readSourceBoundary,
  readParticipantSourceBoundaries,
  readConversationDeliverySources
} from './conversation-read-model'
import {
  requireConversation,
  requireRecord,
  assertGeneration,
  validateIdentity,
  sameScope,
  participant,
  writeParticipant,
  writeIntent,
  writeConversation
} from './conversation-store-transitions'

export function beginConversationSwitch(
  db: Database.Database,
  state: AgentSessionStoreState,
  request: ConversationSwitchRequest,
  operation: AgentSessionOperationAdmission,
  founding?: AgentSessionReserveRequest
) {
  const admission = admitAndClaimAgentSessionOperationInto(
    state,
    operation,
    (d) => d.decision === 'admit'
  )
  const key = agentSessionOperationKey(operation.callerKey, operation.operationId)
  if (admission.decision.decision !== 'admit') {
    return { decision: admission.decision, intent: readSwitchIntent(db, key) }
  }
  const conversation = requireConversation(db, request.conversationId)
  assertGeneration(conversation, request)
  if (conversation.pendingOperationKey) {
    throw new ConversationRefusal('busy')
  }
  if (founding) {
    if (
      founding.sessionId !== request.target.sessionId ||
      founding.operation.callerKey !== operation.callerKey ||
      founding.operation.operationId !== operation.operationId ||
      founding.operation.fingerprint !== operation.fingerprint ||
      founding.surfaceTabId !== undefined ||
      founding.adoptedHandleLink !== undefined
    ) {
      throw new ConversationRefusal('identity-mismatch')
    }
    foundAgentSessionInto(state, founding)
  }
  const target = requireRecord(state, request.target.sessionId)
  validateIdentity(request.target, target)
  if (!sameScope(conversation.location, target.location)) {
    throw new ConversationRefusal('scope-mismatch')
  }
  const active = readSegments(db, conversation.conversationId).find(
    (s) => s.segmentId === conversation.activeSegmentId
  )
  if (!active) {
    throw new ConversationRefusal('corrupt-record')
  }
  if (active.sessionId === target.sessionId) {
    throw new ConversationRefusal('invalid-phase')
  }
  const existing = readParticipant(db, target.sessionId)
  if (existing && existing.conversationId !== conversation.conversationId) {
    throw new ConversationRefusal('already-bound')
  }
  const member = existing ?? participant(conversation, target, 'parked')
  validateIdentity(member, target)
  if (
    member.nativeBindingGeneration !== request.expectedNativeBindingGeneration ||
    member.contextGeneration !== conversation.contextGeneration
  ) {
    throw new ConversationRefusal('stale-generation')
  }
  const sourceBoundaries = readConversationDeliverySources(
    db,
    conversation.conversationId,
    target.sessionId
  )
  const candidateBoundary = readSourceBoundary(db, target.sessionId)
  writeParticipant(db, member)
  pinJournalEpoch(db, {
    ownerId: `conversation-switch:${key}:candidate`,
    ...candidateBoundary
  })
  const intent: ConversationSwitchIntent = {
    candidateSegmentId: reserveConversationCandidateSegment(
      db,
      conversation,
      member,
      candidateBoundary,
      target,
      founding !== undefined
    ),
    operationKey: key,
    conversationId: conversation.conversationId,
    targetSessionId: target.sessionId,
    contextGeneration: conversation.contextGeneration,
    activationFence: conversation.activationFence + 1,
    nativeBindingGeneration: member.nativeBindingGeneration,
    version: 1,
    phase: 'quiescing',
    sourceBoundaries,
    candidateBoundary,
    candidateBaseline: readParticipantSourceBoundaries(db, target.sessionId),
    manifestId: null,
    deliveryReceiptId: null
  }
  writeIntent(db, intent)
  writeConversation(db, {
    ...conversation,
    revision: conversation.revision + 1,
    pendingOperationKey: key
  })
  return { decision: admission.decision, intent }
}
