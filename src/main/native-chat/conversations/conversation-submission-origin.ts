import type Database from '../../sqlite/sync-database'
import type { AgentSessionLease } from '../../../shared/agent-session-record'
import { agentSessionLeaseAdmitsWriter } from '../../../shared/agent-session-lease-adjudication'
import type { JournalOperationReceipt } from '../agent-session-journal/journal-row-writer'
import { bindConversationOrigin, parseConversationOrigin } from './conversation-origin'
import { readConversationNativeIdentity } from './conversation-origin-native-identity'
import {
  ConversationRefusal,
  readConversation,
  readConversationSegment,
  readConversationSessionRoute,
  readParticipant
} from './conversation-read-model'

/** Capture send admission, not the active segment when a later provider callback arrives. */
export function prepareConversationSubmissionOriginReceipt(
  db: Database.Database,
  sessionId: string,
  readLease: () => AgentSessionLease | undefined
): JournalOperationReceipt {
  const read = () => {
    const member = readParticipant(db, sessionId)
    if (!member) {
      return { kind: 'unbound' as const }
    }
    const conversation = readConversation(db, member.conversationId)
    const route = readConversationSessionRoute(db, sessionId)
    const segment = conversation
      ? readConversationSegment(db, member.conversationId, conversation.activeSegmentId)
      : null
    const lease = readLease()
    const fence = lease?.runtimeFence
    if (
      !conversation ||
      !segment ||
      !fence ||
      route.role !== 'active' ||
      route.mutation !== 'none' ||
      segment.lifecycle === 'candidate' ||
      segment.sessionId !== sessionId ||
      member.contextGeneration !== conversation.contextGeneration ||
      segment.contextGeneration !== conversation.contextGeneration ||
      segment.nativeBindingGeneration !== member.nativeBindingGeneration
    ) {
      return { kind: 'blocked' as const }
    }
    const origin = {
      conversationId: conversation.conversationId,
      segmentId: segment.segmentId,
      contextGeneration: conversation.contextGeneration,
      nativeBindingGeneration: member.nativeBindingGeneration
    }
    const nativeIdentity = readConversationNativeIdentity(db, sessionId)
    const liveWriter = lease ? agentSessionLeaseAdmitsWriter(lease) : false
    const acquisition = liveWriter
      ? db
          .prepare(
            'SELECT origin_json,native_identity FROM conversation_origin_acquisitions WHERE session_id=? AND fence=?'
          )
          .get(sessionId, fence)
      : undefined
    if (liveWriter && !acquisition) {
      return { kind: 'blocked' as const }
    }
    if (acquisition) {
      const captured = parseConversationOrigin(JSON.parse(String(acquisition.origin_json)))
      if (
        acquisition.native_identity !== nativeIdentity ||
        captured.conversationId !== origin.conversationId ||
        captured.contextGeneration !== origin.contextGeneration ||
        captured.nativeBindingGeneration !== origin.nativeBindingGeneration
      ) {
        return { kind: 'blocked' as const }
      }
    }
    return {
      kind: 'admitted' as const,
      origin,
      fence,
      liveWriter,
      activationFence: conversation.activationFence,
      nativeIdentity,
      acquisition: acquisition?.origin_json ?? null
    }
  }
  const admitted = read()
  const admissionJson = JSON.stringify(admitted)
  return {
    write: (connection, row) => {
      if (row?.kind !== 'submission') {
        return
      }
      if (connection !== db || !db.isTransaction || JSON.stringify(read()) !== admissionJson) {
        throw new ConversationRefusal('scope-mismatch')
      }
      if (admitted.kind === 'unbound') {
        return
      }
      if (admitted.kind !== 'admitted' || row.fence !== admitted.fence) {
        throw new ConversationRefusal('scope-mismatch')
      }
      if (
        !db
          .prepare('SELECT 1 FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?')
          .get(sessionId, row.epoch, row.seq)
      ) {
        throw new ConversationRefusal('missing-source')
      }
      bindConversationOrigin(db, {
        sessionId,
        key: { kind: 'submission', id: row.clientMessageId },
        origin: admitted.origin
      })
    },
    committed: () => {}
  }
}
