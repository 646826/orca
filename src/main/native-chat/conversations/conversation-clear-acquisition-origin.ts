import { MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS } from '../../../shared/agent-session-provider-handle'
import { readConversationNativeRecord } from './conversation-origin-native-identity'
import { createHash } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { parseJournalRow } from '../agent-session-journal/journal-row-schema'
import { conversationContextDigest } from './conversation-context-consent'
import {
  readConversation,
  readConversationSegment,
  readParticipant
} from './conversation-read-model'
import { readConversationClearIntent } from './conversation-pending-mutation'
import { readConversationClearRowOrigin } from './conversation-clear-origin'

/** Only a receipt-committed clear can found a replacement native generation. */
export function readConversationClearAcquisitionAuthority(
  db: Database.Database,
  sessionId: string
) {
  return readClearAuthority(db, sessionId, false)
}

export function readConversationPublishedClearAuthority(db: Database.Database, sessionId: string) {
  return readClearAuthority(db, sessionId, true)
}

function readClearAuthority(db: Database.Database, sessionId: string, published: boolean) {
  const record = readConversationNativeRecord(db, sessionId)
  if (!record) {
    return null
  }
  const boundary = record.providerContextBoundary
  const member = readParticipant(db, sessionId)
  if (!boundary || !member) {
    return null
  }
  const conversation = readConversation(db, member.conversationId)
  const segment = readConversationSegment(
    db,
    member.conversationId,
    `conversation-clear:${boundary.operationId}`
  )
  if (
    !conversation ||
    !segment ||
    (!published && conversation.pendingOperationKey !== null) ||
    (!published && conversation.activeSegmentId !== segment.segmentId) ||
    segment.sessionId !== sessionId ||
    segment.lifecycle !== 'activated' ||
    segment.contextGeneration !== conversation.contextGeneration ||
    member.contextGeneration !== conversation.contextGeneration ||
    member.nativeBindingGeneration !== segment.nativeBindingGeneration ||
    (!published && segment.activationFence !== conversation.activationFence) ||
    record.lease.runtimeFence <= boundary.afterFence
  ) {
    return null
  }
  const saved = db
    .prepare(
      'SELECT operation_key,retention_owner_id FROM conversation_clear_rows WHERE session_id=? AND epoch=? AND sequence=?'
    )
    .get(sessionId, segment.boundary.epoch, segment.startSequence - 1)
  if (typeof saved?.operation_key !== 'string') {
    return null
  }
  const intent = readConversationClearIntent(db, saved.operation_key)
  const participant = intent?.participants.find((p) => p.sessionId === sessionId)
  const source = intent?.sourceBoundaries.find((s) => s.sessionId === sessionId)
  if (
    !intent ||
    intent.phase !== 'committed' ||
    !participant ||
    participant.nativeIdentities === undefined ||
    !source ||
    createHash('sha256').update(intent.operationKey).digest('hex') !== boundary.operationId ||
    intent.conversationId !== member.conversationId ||
    intent.contextGeneration + 1 !== member.contextGeneration ||
    intent.activationFence + 1 !== segment.activationFence ||
    participant.nativeBindingGeneration + 1 !== member.nativeBindingGeneration ||
    participant.runtimeFence !== boundary.afterFence ||
    participant.recordBirthDigest !==
      conversationContextDigest({
        sessionId: record.sessionId,
        createdAt: record.createdAt,
        provider: record.provider,
        location: record.location,
        accountHome: record.accountHome
      }) ||
    source.epoch !== segment.boundary.epoch ||
    source.endSequence + 3 !== segment.startSequence ||
    saved.retention_owner_id !== `conversation-clear:${boundary.operationId}:archive`
  ) {
    return null
  }
  const row = db
    .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?')
    .get(sessionId, source.epoch, source.endSequence + 2)
  const parsed = typeof row?.row_json === 'string' ? parseJournalRow(row.row_json) : null
  if (
    !parsed?.ok ||
    parsed.row.kind !== 'tombstone' ||
    parsed.row.queueClear?.operationId !== boundary.operationId ||
    !db
      .prepare(
        'SELECT 1 FROM journal_epoch_pins WHERE owner_id=? AND session_id=? AND epoch=? AND end_sequence=?'
      )
      .get(saved.retention_owner_id, sessionId, source.epoch, source.endSequence + 2)
  ) {
    return null
  }
  const status = db
    .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?')
    .get(sessionId, source.epoch, source.endSequence + 1)
  const parsedStatus =
    typeof status?.row_json === 'string' ? parseJournalRow(status.row_json) : null
  if (
    !parsedStatus?.ok ||
    parsedStatus.row.kind !== 'item' ||
    parsedStatus.row.body.kind !== 'status' ||
    JSON.stringify(parsedStatus.row.body.contextClear) !== JSON.stringify(boundary)
  ) {
    return null
  }
  const oldOrigin = readConversationClearRowOrigin(db, sessionId, parsed.row)
  if (
    !oldOrigin ||
    oldOrigin.contextGeneration !== intent.contextGeneration ||
    oldOrigin.nativeBindingGeneration !== participant.nativeBindingGeneration
  ) {
    return null
  }
  if (!conversationClearNativeHistoryKnown(db, member.conversationId, sessionId)) {
    return null
  }
  return {
    record,
    operationKey: intent.operationKey,
    origin: {
      conversationId: member.conversationId,
      segmentId: segment.segmentId,
      contextGeneration: member.contextGeneration,
      nativeBindingGeneration: member.nativeBindingGeneration
    }
  }
}

export function conversationClearRetainsNativeIdentity(
  db: Database.Database,
  conversationId: string,
  sessionId: string,
  identity: string
): boolean {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM conversation_clear_intents c,
    json_each(c.record_json,'$.participants') p, json_each(p.value,'$.nativeIdentities') n
    WHERE c.conversation_id=? AND json_extract(c.record_json,'$.phase')='committed'
      AND json_extract(p.value,'$.sessionId')=? AND n.value=? LIMIT 1`)
      .get(conversationId, sessionId, identity)
  )
}

export function conversationClearNativeHistoryKnown(
  db: Database.Database,
  conversationId: string,
  sessionId: string
): boolean {
  return !db
    .prepare(`SELECT 1 FROM conversation_clear_intents c, json_each(c.record_json,'$.participants') p
    WHERE c.conversation_id=? AND json_extract(c.record_json,'$.phase')='committed'
      AND json_extract(p.value,'$.sessionId')=? AND (
        json_type(p.value,'$.nativeIdentities') IS NOT 'array' OR
        json_array_length(p.value,'$.nativeIdentities')>? OR
        EXISTS(SELECT 1 FROM json_each(p.value,'$.nativeIdentities') n
          WHERE n.type!='text' OR length(n.value)!=64 OR n.value GLOB '*[^0-9a-f]*')) LIMIT 1`)
    .get(conversationId, sessionId, MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS)
}
