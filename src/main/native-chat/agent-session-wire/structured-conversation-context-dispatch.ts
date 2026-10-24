import { refreshVerifiedConversationManifestIndex } from '../conversations/conversation-delivery-reauthorization'
import { observeConversationNativeInput } from '../conversations/conversation-delivery-receipt'
import { readConversationTransfer } from '../conversations/conversation-trigger-reservation'
import { verifyConversationTriggerAttachmentBytes } from '../conversations/conversation-trigger-attachments'
import type { ConversationNativeInputObservation } from '../conversations/conversation-delivery-transport'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import { AgentSessionPreDispatchError } from './structured-agent-session-operation-settlement'

export type ConversationContextDispatchObserver = (
  observation: ConversationNativeInputObservation,
  signal?: AbortSignal
) => Promise<void>

/** Runs at the adapter's final serializer, outside SQLite and host queues. */
export function conversationContextDispatchObserver(
  deps: StructuredAgentSessionHostDeps,
  sessionId: string,
  submissionId: string
): ConversationContextDispatchObserver {
  return async (observation, signal) => {
    const db = deps.journalDatabase.db
    const row = db
      .prepare(
        'SELECT transfer_id FROM conversation_trigger_reservations WHERE target_session_id=? AND target_submission_id=?'
      )
      .get(sessionId, submissionId)
    if (!row) {
      if (deps.store.conversations.route(sessionId).role === 'candidate') {
        throw new AgentSessionPreDispatchError('candidate-context-unverified')
      }
      return
    }
    try {
      if (typeof row.transfer_id !== 'string') {
        throw new Error('Delivery host unavailable')
      }
      const transfer = readConversationTransfer(db, row.transfer_id)
      if (
        !transfer ||
        transfer.binding.targetSessionId !== sessionId ||
        transfer.binding.targetSubmissionId !== submissionId
      ) {
        throw new Error('Transfer identity changed')
      }
      if (!signal) {
        throw new Error('Dispatch cancellation signal unavailable')
      }
      await verifyConversationTriggerAttachmentBytes(
        deps.journalDatabase.stateDirectory,
        db,
        transfer.binding,
        signal
      )
      if (transfer.binding.kind === 'queued-continuation') {
        return
      }
      if (!deps.conversationDeliveryHost) {
        throw new Error('Delivery host unavailable')
      }
      await observeConversationNativeInput(
        db,
        { planId: transfer.binding.deliveryPlanId, submissionId, observation },
        deps.conversationDeliveryHost,
        signal
      )
      await deps.bindConversationEvidencePlan?.(sessionId, transfer.binding.deliveryPlanId, signal)
      signal.throwIfAborted()
    } catch {
      // This hook runs before the user-turn frame; options may already have changed.
      throw new AgentSessionPreDispatchError('candidate-context-unverified')
    }
  }
}

/** Revalidates after the canonical handover commit, before the adapter's first dispatch gate. */
export async function prepareConversationSubmissionContext(
  deps: StructuredAgentSessionHostDeps,
  sessionId: string,
  submissionId: string,
  signal?: AbortSignal
): Promise<void> {
  const db = deps.journalDatabase.db
  const row = db
    .prepare(
      'SELECT transfer_id FROM conversation_trigger_reservations WHERE target_session_id=? AND target_submission_id=?'
    )
    .get(sessionId, submissionId)
  if (!row) {
    return
  }
  try {
    if (typeof row.transfer_id !== 'string' || !signal) {
      throw new Error('Transfer dispatch proof unavailable')
    }
    const transfer = readConversationTransfer(db, row.transfer_id)
    if (
      !transfer ||
      transfer.binding.targetSessionId !== sessionId ||
      transfer.binding.targetSubmissionId !== submissionId
    ) {
      throw new Error('Transfer identity changed')
    }
    signal.throwIfAborted()
    if (transfer.binding.kind === 'queued-continuation') {
      return
    }
    if (!deps.conversationDeliveryHost) {
      throw new Error('Delivery host unavailable')
    }
    await refreshVerifiedConversationManifestIndex(
      db,
      transfer.binding.manifestId,
      deps.conversationDeliveryHost.readPreparationEvidence,
      signal
    )
  } catch {
    throw new AgentSessionPreDispatchError('candidate-context-unverified')
  }
}
