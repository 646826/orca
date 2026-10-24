import type Database from '../../sqlite/sync-database'
import {
  readConversation,
  readConversationSegment,
  readParticipant
} from './conversation-read-model'
import { readConversationEnrollmentOrigin } from './conversation-origin-capture'

export type ConversationEnrollmentAcquisition = { generation: string; fence: number }

/** Initial enrollment authorizes only its frozen segment, never a later active span. */
export function readConversationEnrollmentNativeAuthority(
  db: Database.Database,
  sessionId: string
) {
  return readEnrollmentAuthority(db, sessionId)
}

export function readConversationPublishedEnrollmentAuthority(
  db: Database.Database,
  sessionId: string,
  segmentId: string
) {
  return readEnrollmentAuthority(db, sessionId, segmentId)
}

function readEnrollmentAuthority(
  db: Database.Database,
  sessionId: string,
  publishedSegmentId?: string
) {
  const member = readParticipant(db, sessionId)
  const conversation = member && readConversation(db, member.conversationId)
  const segment =
    conversation &&
    readConversationSegment(
      db,
      conversation.conversationId,
      publishedSegmentId ?? conversation.activeSegmentId
    )
  if (
    !member ||
    !conversation ||
    !segment ||
    (!publishedSegmentId && conversation.pendingOperationKey !== null) ||
    segment.sessionId !== sessionId ||
    segment.ordinal !== 1 ||
    segment.startSequence !== 1 ||
    segment.lifecycle !== 'activated' ||
    segment.contextGeneration !== 1 ||
    member.contextGeneration !== 1 ||
    conversation.contextGeneration !== 1 ||
    segment.nativeBindingGeneration !== 1 ||
    member.nativeBindingGeneration !== 1
  ) {
    return null
  }
  const origin = readConversationEnrollmentOrigin(db, {
    sessionId,
    epoch: segment.boundary.epoch,
    sequence: 1
  })
  if (!origin || origin.segmentId !== segment.segmentId) {
    return null
  }
  return { operationKey: `conversation-enrollment:${segment.segmentId}`, origin }
}
