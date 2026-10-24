import { assertQueuedDraftOrdinaryAction } from '../agent-session-journal/queued-message-origin'
import { ConversationRefusal } from '../conversations/conversation-read-model'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import {
  canDispatchConversationTransfer,
  type ConversationTriggerAuthority
} from '../conversations/conversation-trigger-reservation'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

/** Durable authority for the existing delivery loop, not a second dispatch queue. */
export function canDispatchConversationSubmission(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'journalDatabase'> & {
    conversationTransferAuthority?: ConversationTriggerAuthority
  },
  sessionId: string,
  epoch: string,
  submission: AgentJournalSubmission
): boolean {
  const row = deps.journalDatabase.db
    .prepare(
      'SELECT transfer_id FROM conversation_trigger_reservations WHERE target_session_id=? AND target_submission_id=?'
    )
    .get(sessionId, submission.clientMessageId)
  if (!deps.store.getRecord(sessionId)) {
    return false
  }
  if (submission.queuedMessageId && !row) {
    try {
      assertQueuedDraftOrdinaryAction(deps.journalDatabase.db, {
        sessionId,
        messageId: submission.queuedMessageId
      })
    } catch (error) {
      if (error instanceof ConversationRefusal) {
        return false
      }
      throw error
    }
  }
  const route = deps.store.conversations.route(sessionId)
  if (route.role === 'unbound') {
    return !row
  }
  const conversation = deps.store.conversations.read(route.conversationId)
  if (!conversation) {
    return false
  }
  if (route.mutation === 'clear') {
    const clear = conversation.pendingOperationKey
      ? deps.store.conversations.clear.intent(conversation.pendingOperationKey)
      : null
    const acceptedSequence = submission.acceptedSequence
    if (
      route.role !== 'active' ||
      clear?.phase !== 'quiescing' ||
      acceptedSequence === undefined ||
      !clear.sourceBoundaries.some(
        (boundary) =>
          boundary.sessionId === sessionId &&
          boundary.epoch === epoch &&
          acceptedSequence <= boundary.endSequence
      )
    ) {
      return false
    }
  }
  const intent = conversation.pendingOperationKey
    ? deps.store.conversations.intent(conversation.pendingOperationKey)
    : null
  if (route.role === 'active' && route.switching) {
    // Drain only sends accepted before the freeze, never new draft promotions.
    const acceptedSequence = submission.acceptedSequence
    if (
      acceptedSequence === undefined ||
      intent?.phase !== 'quiescing' ||
      !intent.sourceBoundaries.some(
        (boundary) =>
          boundary.sessionId === sessionId &&
          boundary.epoch === epoch &&
          acceptedSequence <= boundary.endSequence
      )
    ) {
      return false
    }
  } else if (route.role !== 'active' && (route.role !== 'candidate' || !intent)) {
    return false
  }
  if (!row) {
    return route.role === 'active'
  }
  const transferId = row.transfer_id
  const authority = deps.conversationTransferAuthority
  if (typeof transferId !== 'string' || !authority) {
    return false
  }
  return deps.journalDatabase.transaction((db) => {
    return canDispatchConversationTransfer(
      db,
      {
        transferId,
        targetSessionId: sessionId,
        targetSubmissionId: submission.clientMessageId
      },
      authority
    )
  })
}
