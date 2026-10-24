import { agentSessionJournalProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentSessionLeaseAdmitsWriter } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { bindConversationAcquisition } from './conversation-origin-capture'
import { randomUUID } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import type {
  ConversationRecord,
  ConversationParticipant,
  ConversationSourceBoundary,
  ConversationSegment
} from '../../../shared/conversation-record'
import { ConversationRefusal, readSegments } from './conversation-read-model'
import { parseJournalRow } from '../agent-session-journal/journal-row-schema'
import { attributeConversationSourceBoundary } from './conversation-source-attribution'
import { writeSegment, validateIdentity } from './conversation-store-transitions'

/** Preallocated origin only; no source span is claimed until an actual row is attributed. */
export function reserveConversationCandidateSegment(
  db: Database.Database,
  conversation: ConversationRecord,
  member: ConversationParticipant,
  boundary: ConversationSourceBoundary,
  record: AgentSessionRecord,
  freshlyFounded = false
): string {
  validateIdentity(member, record)
  if (freshlyFounded) {
    const rows = db
      .prepare(
        'SELECT epoch,seq,CASE WHEN octet_length(row_json)<=65536 THEN row_json END row_json FROM journal_rows WHERE session_id=? LIMIT 2'
      )
      .all(member.sessionId)
    const raw = rows[0]
    const parsed = typeof raw?.row_json === 'string' ? parseJournalRow(raw.row_json) : null
    if (
      record.providerHandleChain.length !== 0 ||
      rows.length !== 1 ||
      boundary.endSequence !== 1 ||
      raw?.seq !== 1 ||
      raw.epoch !== boundary.epoch ||
      !parsed?.ok ||
      parsed.row.kind !== 'epoch' ||
      parsed.row.reason !== 'session_created' ||
      parsed.row.epoch !== boundary.epoch ||
      parsed.row.seq !== 1 ||
      JSON.stringify(parsed.row.providerHandle) !==
        JSON.stringify(
          agentSessionJournalProviderHandle({ providerHandle: null, agent: record.provider })
        )
    ) {
      throw new ConversationRefusal('unverified-delivery')
    }
  }
  const segments = readSegments(db, conversation.conversationId)
  const prior = segments.findLast(
    (segment) =>
      segment.lifecycle !== 'candidate' &&
      segment.sessionId === member.sessionId &&
      segment.boundary.epoch === boundary.epoch
  )
  const segment: ConversationSegment = {
    segmentId: randomUUID(),
    conversationId: conversation.conversationId,
    ordinal: (segments.at(-1)?.ordinal ?? 0) + 1,
    sessionId: member.sessionId,
    contextGeneration: conversation.contextGeneration,
    activationFence: conversation.activationFence + 1,
    nativeBindingGeneration: member.nativeBindingGeneration,
    lifecycle: 'candidate',
    startSequence: prior ? prior.boundary.endSequence + 1 : 1,
    boundary
  }
  writeSegment(db, segment)
  if (freshlyFounded) {
    attributeConversationSourceBoundary(
      db,
      segment.segmentId,
      member.sessionId,
      segment.contextGeneration,
      boundary
    )
  }
  if (agentSessionLeaseAdmitsWriter(record.lease)) {
    bindConversationAcquisition(db, {
      sessionId: member.sessionId,
      fence: record.lease.runtimeFence,
      origin: {
        conversationId: conversation.conversationId,
        segmentId: segment.segmentId,
        contextGeneration: segment.contextGeneration,
        nativeBindingGeneration: segment.nativeBindingGeneration
      }
    })
  }
  return segment.segmentId
}
