import type { ConversationEnrollmentAcquisition } from './conversation-enrollment-native-origin'
import { prepareConversationPendingNativeIdentity } from './conversation-pending-native-identity'
import { agentSessionLeaseAdmitsWriter } from '../../../shared/agent-session-lease-adjudication'
import {
  recordConversationOriginEnrollment,
  bindConversationAcquisition
} from './conversation-origin-capture'
import { randomUUID } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import type { AgentSessionStoreState } from '../../runtime/agent-session-store-state'
import type { ConversationRecord, ConversationSegment } from '../../../shared/conversation-record'
import { readParticipant, readSourceBoundary } from './conversation-read-model'
import {
  requireRecord,
  validateIdentity,
  requireConversation,
  writeConversation,
  writeParticipant,
  participant,
  writeSegment
} from './conversation-store-transitions'
import { registerConversationSourceSpan } from './conversation-source-attribution'
import { pinJournalEpoch } from '../agent-session-journal/journal-epoch-pins'
export function ensureConversationSingleton(
  db: Database.Database,
  state: AgentSessionStoreState,
  sessionId: string,
  acquisition?: ConversationEnrollmentAcquisition
): ConversationRecord {
  const record = requireRecord(state, sessionId)
  const member = readParticipant(db, sessionId)
  if (member) {
    validateIdentity(member, record)
    return requireConversation(db, member.conversationId)
  }
  const pendingNative =
    agentSessionLeaseAdmitsWriter(record.lease) && record.providerHandleChain.length === 0
  if (
    pendingNative &&
    (!acquisition?.generation ||
      acquisition.fence !== record.lease.runtimeFence ||
      !record.lease.ownerProcess)
  ) {
    throw new Error('conversation enrollment requires current native acquisition')
  }
  const boundary = readSourceBoundary(db, sessionId)
  const conversationId = randomUUID()
  const segmentId = randomUUID()
  const conversation: ConversationRecord = {
    conversationId,
    location: record.location,
    revision: 1,
    contextGeneration: 1,
    activationFence: 1,
    activeSegmentId: segmentId,
    pendingOperationKey: null
  }
  writeConversation(db, conversation)
  writeParticipant(db, participant(conversation, record, 'active'))
  const segment: ConversationSegment = {
    segmentId,
    lifecycle: 'activated',
    conversationId,
    ordinal: 1,
    sessionId,
    contextGeneration: 1,
    activationFence: 1,
    nativeBindingGeneration: 1,
    startSequence: 1,
    boundary
  }
  writeSegment(db, segment)
  registerConversationSourceSpan(db, segment, boundary, segment.startSequence)
  pinJournalEpoch(db, { ownerId: `conversation-segment:${segmentId}:initial`, ...boundary })
  recordConversationOriginEnrollment(db, {
    ...boundary,
    origin: {
      conversationId,
      segmentId,
      contextGeneration: 1,
      nativeBindingGeneration: 1
    }
  })
  if (agentSessionLeaseAdmitsWriter(record.lease)) {
    bindConversationAcquisition(db, {
      sessionId,
      fence: record.lease.runtimeFence,
      origin: { conversationId, segmentId, contextGeneration: 1, nativeBindingGeneration: 1 }
    })
  }
  if (pendingNative) {
    prepareConversationPendingNativeIdentity(db, {
      before: record,
      origin: { conversationId, segmentId, contextGeneration: 1, nativeBindingGeneration: 1 },
      acquisitionGeneration: acquisition?.generation
    })
  }
  return conversation
}
