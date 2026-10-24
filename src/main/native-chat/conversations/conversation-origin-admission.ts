import {
  readConversationClearAcquisitionAuthority,
  conversationClearNativeHistoryKnown
} from './conversation-clear-acquisition-origin'
import { readConversationPreparedClearNativeOrigin } from './conversation-pending-native-identity'
import { readConversationNativeIdentity } from './conversation-origin-native-identity'
import type Database from '../../sqlite/sync-database'
import {
  readConversation,
  readParticipant,
  readSegments,
  readSwitchIntent
} from './conversation-read-model'
import {
  bindConversationAcquisition,
  readConversationEnrollmentOrigin
} from './conversation-origin-capture'
import {
  assertConversationOrigin,
  parseConversationOrigin,
  type ConversationOrigin
} from './conversation-origin'

/** Capture before native effects; authority is a frozen enrollment or an exact candidate intent. */
export function captureConversationAcquisitionOrigin(
  db: Database.Database,
  sessionId: string
): ConversationOrigin | null {
  const member = readParticipant(db, sessionId)
  if (!member) {
    return null
  }
  const conversation = readConversation(db, member.conversationId)
  if (!conversation) {
    throw new Error('missing conversation acquisition authority')
  }
  if (member.contextGeneration !== conversation.contextGeneration) {
    throw new Error('conversation acquisition generation changed')
  }
  if (!conversationClearNativeHistoryKnown(db, member.conversationId, sessionId)) {
    throw new Error('conversation cleared native history unknown')
  }
  const intent = conversation.pendingOperationKey
    ? readSwitchIntent(db, conversation.pendingOperationKey)
    : null
  if (intent?.targetSessionId === sessionId && intent.candidateSegmentId) {
    const candidate = readSegments(db, conversation.conversationId).find(
      (segment) => segment.segmentId === intent.candidateSegmentId
    )
    if (
      !candidate ||
      candidate.lifecycle !== 'candidate' ||
      candidate.contextGeneration !== intent.contextGeneration ||
      candidate.nativeBindingGeneration !== member.nativeBindingGeneration
    ) {
      throw new Error('invalid conversation candidate acquisition')
    }
    return {
      conversationId: candidate.conversationId,
      segmentId: candidate.segmentId,
      contextGeneration: candidate.contextGeneration,
      nativeBindingGeneration: candidate.nativeBindingGeneration
    }
  }
  const prior = db
    .prepare(`SELECT origin_json,native_identity FROM conversation_origin_acquisitions
    WHERE session_id=? AND json_extract(origin_json,'$.conversationId')=?
      AND json_extract(origin_json,'$.contextGeneration')=?
      AND json_extract(origin_json,'$.nativeBindingGeneration')=? ORDER BY fence DESC LIMIT 1`)
    .get(sessionId, member.conversationId, member.contextGeneration, member.nativeBindingGeneration)
  if (prior) {
    const identity = readConversationNativeIdentity(db, sessionId)
    if (typeof prior.native_identity !== 'string' || identity !== prior.native_identity) {
      throw new Error('conversation native identity changed or unverified')
    }
    const origin = parseConversationOrigin(JSON.parse(String(prior.origin_json)))
    assertConversationOrigin(db, sessionId, origin)
    return origin
  }
  const clear = readConversationClearAcquisitionAuthority(db, sessionId)
  if (
    clear &&
    clear.record.providerHandleChain.length === 0 &&
    clear.record.lease.claimStatus === 'reserved'
  ) {
    return clear.origin
  }
  if (
    db
      .prepare('SELECT 1 FROM conversation_origin_acquisitions WHERE session_id=? LIMIT 1')
      .get(sessionId)
  ) {
    throw new Error('conversation acquisition generation changed')
  }
  const enrollment = db
    .prepare('SELECT epoch FROM conversation_origin_enrollments WHERE session_id=?')
    .get(sessionId)
  if (typeof enrollment?.epoch !== 'string') {
    return null
  }
  const origin = readConversationEnrollmentOrigin(db, {
    sessionId,
    epoch: enrollment.epoch,
    sequence: 1
  })
  return origin?.contextGeneration === conversation.contextGeneration &&
    origin.nativeBindingGeneration === member.nativeBindingGeneration
    ? origin
    : null
}
export function commitConversationAcquisitionOrigin(
  db: Database.Database,
  input: {
    sessionId: string
    fence: number
    origin: ConversationOrigin
  }
): void {
  assertConversationOrigin(db, input.sessionId, input.origin)
  const expected =
    readConversationPreparedClearNativeOrigin(db, input) ??
    captureConversationAcquisitionOrigin(db, input.sessionId)
  if (
    !expected ||
    expected.segmentId !== input.origin.segmentId ||
    expected.contextGeneration !== input.origin.contextGeneration ||
    expected.nativeBindingGeneration !== input.origin.nativeBindingGeneration
  ) {
    throw new Error('conversation acquisition authority changed')
  }
  bindConversationAcquisition(db, input)
}
