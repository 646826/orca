import { readQueuedConversationOrigin } from '../agent-session-journal/queued-message-origin'
import { readConversationNativeIdentity } from './conversation-origin-native-identity'
import { readConversation, readParticipant } from './conversation-read-model'
import type Database from '../../sqlite/sync-database'
import { isConversationSegment } from '../../../shared/conversation-record'
import type {
  JournalRow,
  JournalLifecycleMutation
} from '../agent-session-journal/journal-row-schema'
import { pinJournalEpoch } from '../agent-session-journal/journal-epoch-pins'
import {
  assertConversationOrigin,
  readConversationOrigin,
  parseConversationOrigin,
  type ConversationOrigin,
  type ConversationOriginScope
} from './conversation-origin'

export function bindConversationAcquisition(
  db: Database.Database,
  input: {
    sessionId: string
    fence: number
    origin: ConversationOrigin
  }
): void {
  if (!db.isTransaction || !Number.isSafeInteger(input.fence) || input.fence < 1) {
    throw new Error('invalid conversation acquisition')
  }
  assertConversationOrigin(db, input.sessionId, input.origin)
  const nativeIdentity = readConversationNativeIdentity(db, input.sessionId)
  const prior = db
    .prepare(
      'SELECT origin_json,native_identity FROM conversation_origin_acquisitions WHERE session_id=? AND fence=?'
    )
    .get(input.sessionId, input.fence)
  if (prior) {
    const original = parseConversationOrigin(JSON.parse(String(prior.origin_json)))
    if (
      original.conversationId !== input.origin.conversationId ||
      original.contextGeneration !== input.origin.contextGeneration ||
      original.nativeBindingGeneration !== input.origin.nativeBindingGeneration ||
      prior.native_identity !== nativeIdentity
    ) {
      throw new Error('conversation acquisition cannot be rebound')
    }
    return
  }
  db.prepare('INSERT INTO conversation_origin_acquisitions VALUES(?,?,?,?)').run(
    input.sessionId,
    input.fence,
    JSON.stringify(input.origin),
    nativeIdentity
  )
}
export function readConversationAdmittedSubmissionOrigin(
  db: Database.Database,
  sessionId: string,
  row: Extract<JournalRow, { kind: 'submission' }>
): ConversationOrigin | null {
  const member = readParticipant(db, sessionId)
  const fence = db
    .prepare(
      "SELECT json_extract(record_json,'$.lease.runtimeFence') fence FROM agent_session_records WHERE session_id=?"
    )
    .get(sessionId)?.fence
  const admitted =
    member &&
    readConversationOrigin(
      db,
      sessionId,
      { kind: 'submission', id: row.clientMessageId },
      member.nativeBindingGeneration
    )
  if (
    admitted &&
    fence === row.fence &&
    admitted.conversationId === member?.conversationId &&
    admitted.contextGeneration === member.contextGeneration &&
    readConversation(db, member.conversationId)?.contextGeneration === admitted.contextGeneration
  ) {
    return admitted
  }
  return null
}

export function readConversationCapturedScope(
  db: Database.Database,
  sessionId: string,
  row: JournalRow,
  atomPath: string
): ConversationOriginScope | null {
  if (row.kind === 'queue') {
    return readQueuedConversationOrigin(db, sessionId, row.messageId)
  }
  if (row.kind === 'submission' && atomPath === '$') {
    const admitted = readConversationAdmittedSubmissionOrigin(db, sessionId, row)
    if (admitted) {
      return admitted
    }
  }
  let fact: JournalRow | JournalLifecycleMutation = row
  if (atomPath !== '$') {
    const match = /^\$\.mutations\[(\d+)\]$/.exec(atomPath)
    if (row.kind !== 'lifecycle-batch' || !match || !row.mutations[Number(match[1])]) {
      throw new Error('invalid conversation origin atom')
    }
    fact = row.mutations[Number(match[1])]
  }
  const providerFact = fact.kind === 'item' || fact.kind === 'tombstone'
  const fence =
    'ownerFence' in fact && typeof fact.ownerFence === 'number'
      ? fact.ownerFence
      : providerFact
        ? null
        : row.fence
  if (fence === null) {
    return null
  }
  const saved = db
    .prepare(
      'SELECT origin_json FROM conversation_origin_acquisitions WHERE session_id=? AND fence=?'
    )
    .get(sessionId, fence)
  if (!saved) {
    return null
  }
  const origin = parseConversationOrigin(JSON.parse(String(saved.origin_json)))
  assertConversationOrigin(db, sessionId, origin)
  if (providerFact && fence !== row.fence) {
    const writer = db
      .prepare(
        'SELECT origin_json FROM conversation_origin_acquisitions WHERE session_id=? AND fence=?'
      )
      .get(sessionId, row.fence)
    if (!writer) {
      return null
    }
    const writerOrigin = parseConversationOrigin(JSON.parse(String(writer.origin_json)))
    if (
      writerOrigin.conversationId !== origin.conversationId ||
      writerOrigin.contextGeneration !== origin.contextGeneration ||
      writerOrigin.nativeBindingGeneration !== origin.nativeBindingGeneration
    ) {
      return null
    }
  }
  return origin
}

/** Enrollment defines only the frozen initial history, never subsequent unsolicited facts. */
export function recordConversationOriginEnrollment(
  db: Database.Database,
  input: {
    sessionId: string
    epoch: string
    endSequence: number
    origin: ConversationOrigin
  }
): void {
  if (!db.isTransaction) {
    throw new Error('conversation enrollment requires transaction')
  }
  assertConversationOrigin(db, input.sessionId, input.origin)
  const saved = db
    .prepare('SELECT record_json FROM conversation_segments WHERE segment_id=?')
    .get(input.origin.segmentId)
  const segment: unknown = JSON.parse(String(saved?.record_json))
  if (
    !isConversationSegment(segment) ||
    segment.ordinal !== 1 ||
    segment.startSequence !== 1 ||
    segment.boundary.epoch !== input.epoch ||
    segment.boundary.endSequence !== input.endSequence
  ) {
    throw new Error('invalid conversation enrollment boundary')
  }
  const prior = db
    .prepare(
      'SELECT end_sequence,origin_json FROM conversation_origin_enrollments WHERE session_id=? AND epoch=?'
    )
    .get(input.sessionId, input.epoch)
  if (prior) {
    const origin = parseConversationOrigin(JSON.parse(String(prior.origin_json)))
    if (prior.end_sequence !== input.endSequence || origin.segmentId !== input.origin.segmentId) {
      throw new Error('conversation enrollment cannot be rebound')
    }
    return
  }
  pinJournalEpoch(db, {
    ownerId: `conversation-enrollment:${input.origin.segmentId}`,
    sessionId: input.sessionId,
    epoch: input.epoch,
    endSequence: input.endSequence
  })
  db.prepare('INSERT INTO conversation_origin_enrollments VALUES(?,?,?,?)').run(
    input.sessionId,
    input.epoch,
    input.endSequence,
    JSON.stringify(input.origin)
  )
}
export function readConversationEnrollmentOrigin(
  db: Database.Database,
  source: {
    sessionId: string
    epoch: string
    sequence: number
  }
): ConversationOrigin | null {
  if (!Number.isSafeInteger(source.sequence) || source.sequence < 1) {
    return null
  }
  const saved = db
    .prepare(
      'SELECT origin_json FROM conversation_origin_enrollments WHERE session_id=? AND epoch=? AND end_sequence>=?'
    )
    .get(source.sessionId, source.epoch, source.sequence)
  if (!saved) {
    return null
  }
  const origin = parseConversationOrigin(JSON.parse(String(saved.origin_json)))
  assertConversationOrigin(db, source.sessionId, origin)
  if (
    !db
      .prepare('SELECT 1 FROM journal_epoch_pins WHERE owner_id=? AND session_id=? AND epoch=?')
      .get(`conversation-enrollment:${origin.segmentId}`, source.sessionId, source.epoch) ||
    !db
      .prepare('SELECT 1 FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?')
      .get(source.sessionId, source.epoch, source.sequence)
  ) {
    throw new Error('conversation enrollment evidence missing')
  }
  return origin
}
