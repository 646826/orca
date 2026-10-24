import type Database from '../../sqlite/sync-database'
import { isPersistedAgentSessionRecord } from '../../../shared/agent-session-record'
import { conversationContextDigest } from '../conversations/conversation-context-consent'
import {
  ConversationRefusal,
  readConversation,
  readParticipant
} from '../conversations/conversation-read-model'
import {
  parseConversationOrigin,
  type ConversationOrigin
} from '../conversations/conversation-origin'
import { captureConversationAcquisitionOrigin } from '../conversations/conversation-origin-admission'
import { OriginSchema, type QueuedDraftOrigin } from './queued-message-origin-schema'
export {
  createQueuedMessageOriginTablesSql,
  migrateQueuedMessageOrigins,
  type QueuedDraftOrigin
} from './queued-message-origin-schema'
export {
  captureQueuedJournalRowEvidence,
  readQueuedMessageEvidence,
  type QueuedMessageEvidence,
  type QueuedMessageOrder
} from './queued-message-evidence'
export { preserveLegacyQueuedMessageEvidence } from './queued-message-legacy-evidence'
export {
  pinQueuedMessageEvidence,
  readPinnedQueuedMessageEvidence,
  releaseQueuedMessageEvidence
} from './queued-message-evidence-pins'

function currentOrigin(db: Database.Database, sessionId: string): QueuedDraftOrigin | null {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_session_records','conversation_participants')"
    )
    .all()
  if (tables.length === 0) {
    return null
  }
  const raw = db
    .prepare('SELECT record_json FROM agent_session_records WHERE session_id=?')
    .get(sessionId)?.record_json
  const member = readParticipant(db, sessionId)
  if (raw === undefined && !member) {
    return null
  }
  const record: unknown = typeof raw === 'string' ? JSON.parse(raw) : null
  if (!isPersistedAgentSessionRecord(record) || record.sessionId !== sessionId) {
    throw new ConversationRefusal('corrupt-record')
  }
  const conversation = member && readConversation(db, member.conversationId)
  if (member && (!conversation || member.contextGeneration !== conversation.contextGeneration)) {
    throw new ConversationRefusal('stale-generation')
  }
  return {
    birthDigest: conversationContextDigest({
      sessionId,
      createdAt: record.createdAt,
      provider: record.provider,
      location: record.location,
      accountHome: record.accountHome
    }),
    boundaryDigest: conversationContextDigest(record.providerContextBoundary ?? null),
    conversationId: member?.conversationId ?? null,
    contextGeneration: member?.contextGeneration ?? null
  }
}
/** Capture at insertion, never by looking at a later queue cursor or newly enrolled participant. */
export function captureQueuedDraftOrigin(
  db: Database.Database,
  input: { sessionId: string; messageId: string; admittedAt?: number }
): void {
  if (!db.isTransaction) {
    throw new Error('Queued draft origin requires insertion transaction')
  }
  const origin = currentOrigin(db, input.sessionId)
  db.prepare(
    'INSERT INTO queued_message_origins(session_id,message_id,origin_json,admitted_at,conversation_origin_json) VALUES(?,?,?,?,?)'
  ).run(
    input.sessionId,
    input.messageId,
    origin === null ? null : JSON.stringify(origin),
    input.admittedAt ?? null,
    origin?.conversationId
      ? JSON.stringify(captureConversationAcquisitionOrigin(db, input.sessionId))
      : null
  )
}
function hasConversationHistory(db: Database.Database, sessionId: string): boolean {
  // Removing current membership never erases earlier feature enrollment or clear authority.
  return Boolean(
    db
      .prepare(`SELECT 1 WHERE
    EXISTS(SELECT 1 FROM conversation_origin_enrollments WHERE session_id=?) OR
    EXISTS(SELECT 1 FROM conversation_origin_acquisitions WHERE session_id=?) OR
    EXISTS(SELECT 1 FROM conversation_pending_native_identity WHERE session_id=?) OR
    EXISTS(SELECT 1 FROM conversation_clear_rows WHERE session_id=?) OR
    EXISTS(SELECT 1 FROM conversation_segments WHERE json_extract(record_json,'$.sessionId')=?)`)
      .get(sessionId, sessionId, sessionId, sessionId, sessionId)
  )
}
function ordinaryUnknownOrigin(
  db: Database.Database,
  sessionId: string,
  current: QueuedDraftOrigin
): boolean {
  return (
    current.conversationId === null &&
    current.boundaryDigest === conversationContextDigest(null) &&
    !hasConversationHistory(db, sessionId)
  )
}

/** Local queue actions preserve standalone /clear intent, not authority to transfer its old draft. */
export function assertQueuedDraftOrdinaryAction(
  db: Database.Database,
  input: { sessionId: string; messageId: string }
): void {
  const current = currentOrigin(db, input.sessionId)
  if (current?.conversationId != null) {
    assertQueuedDraftCurrentGeneration(db, input)
    return
  }
  if (hasConversationHistory(db, input.sessionId)) {
    throw new ConversationRefusal('stale-generation')
  }
  const raw = db
    .prepare('SELECT origin_json FROM queued_message_origins WHERE session_id=? AND message_id=?')
    .get(input.sessionId, input.messageId)?.origin_json
  if (raw == null) {
    return
  }
  let origin: QueuedDraftOrigin
  try {
    origin = OriginSchema.parse(typeof raw === 'string' ? JSON.parse(raw) : null)
  } catch {
    throw new ConversationRefusal('corrupt-record')
  }
  if (!current || origin.conversationId !== null || origin.birthDigest !== current.birthDigest) {
    throw new ConversationRefusal('stale-generation')
  }
}
/** Standalone journals without a founded record are not runtime dispatch authority. */
export function assertQueuedDraftCurrentGeneration(
  db: Database.Database,
  input: { sessionId: string; messageId: string }
): void {
  const current = currentOrigin(db, input.sessionId)
  if (!current) {
    return
  }
  const raw = db
    .prepare('SELECT origin_json FROM queued_message_origins WHERE session_id=? AND message_id=?')
    .get(input.sessionId, input.messageId)?.origin_json
  if (typeof raw !== 'string') {
    if (raw == null && ordinaryUnknownOrigin(db, input.sessionId, current)) {
      return
    }
    throw new ConversationRefusal('stale-generation')
  }
  const origin = OriginSchema.parse(JSON.parse(raw))
  if (
    origin.birthDigest !== current.birthDigest ||
    origin.boundaryDigest !== current.boundaryDigest ||
    (origin.conversationId !== null &&
      (origin.conversationId !== current.conversationId ||
        origin.contextGeneration !== current.contextGeneration)) ||
    (origin.conversationId === null &&
      current.conversationId !== null &&
      current.contextGeneration !== 1)
  ) {
    throw new ConversationRefusal('stale-generation')
  }
}

export function readQueuedConversationOrigin(
  db: Database.Database,
  sessionId: string,
  messageId: string
): ConversationOrigin | null {
  const raw = db
    .prepare(
      'SELECT CASE WHEN octet_length(conversation_origin_json)<=16384 THEN conversation_origin_json END conversation_origin_json FROM queued_message_origins WHERE session_id=? AND message_id=?'
    )
    .get(sessionId, messageId)?.conversation_origin_json
  return typeof raw === 'string' && raw !== 'null' ? parseConversationOrigin(JSON.parse(raw)) : null
}

export function assertQueuedMessageUnreserved(
  db: Database.Database,
  sessionId: string,
  messageId: string,
  transferId?: string
): void {
  const reservation = db
    .prepare(
      "SELECT transfer_id FROM conversation_trigger_reservations WHERE queue_session_id=? AND message_id=? AND state!='cancelled'"
    )
    .get(sessionId, messageId)
  if (reservation && reservation.transfer_id !== transferId) {
    throw new Error('conversation trigger is reserved')
  }
}
