import { conversationContextDigest } from '../conversations/conversation-context-consent'
import { appendConversationTransfer } from './structured-conversation-source-queue'
import { nextConversationContinuationDraft } from './structured-conversation-continuation-selection'
import type Database from '../../sqlite/sync-database'
import type { ConversationDeliveryHost } from '../conversations/conversation-delivery-plan'
import { readConversation, readSwitchIntent } from '../conversations/conversation-read-model'
import { readConversationTrigger } from '../conversations/conversation-trigger-reservation'
import { stageConversationTriggerClaims } from '../conversations/conversation-trigger-claim-staging'
import { prepareConversationTrigger } from '../conversations/conversation-trigger-claims'

export function conversationContinuationTransferId(
  operationKey: string,
  source: { sessionId: string; messageId: string }
): string {
  return `conversation-continuation:${conversationContextDigest([operationKey, source.sessionId, source.messageId])}`
}

/** Move durable drafts through the ordinary target submission queue, never replay native effects. */
export async function drainConversationContinuations(
  ports: {
    db: Database.Database
    stateDirectory: string
    deliveryHost: ConversationDeliveryHost
    publishSourceQueue(sessionId: string): void
    now(): number
  },
  operationKey: string,
  signal: AbortSignal
): Promise<number> {
  const { db, deliveryHost } = ports
  let count = 0
  for (;;) {
    signal.throwIfAborted()
    const intent = readSwitchIntent(db, operationKey)
    const conversation = intent && readConversation(db, intent.conversationId)
    if (
      !intent ||
      !conversation ||
      intent.phase !== 'activated' ||
      conversation.pendingOperationKey !== null ||
      conversation.contextGeneration !== intent.contextGeneration ||
      conversation.activeSegmentId !== intent.candidateSegmentId
    ) {
      return count
    }
    const trigger = readConversationTrigger(db, operationKey)
    if (!trigger || !intent.deliveryReceiptId) {
      throw new Error('Continuation delivery authority unavailable')
    }
    const draft = nextConversationContinuationDraft(
      db,
      intent,
      deliveryHost.getJournal.bind(deliveryHost)
    )
    if (!draft) {
      return count
    }
    const queueSessionId = draft.sourceSessionId
    const transferId = conversationContinuationTransferId(operationKey, {
      sessionId: queueSessionId,
      messageId: draft.card.messageId
    })
    await stageConversationTriggerClaims(
      db,
      {
        kind: 'queued-continuation',
        transferId,
        operationKey,
        expectedIntentVersion: intent.version,
        queueSessionId,
        messageId: draft.card.messageId,
        stateDirectory: ports.stateDirectory
      },
      ports.now(),
      signal,
      deliveryHost.getJournal.bind(deliveryHost)
    )
    const prepared = await prepareConversationTrigger(
      db,
      {
        kind: 'queued-continuation',
        transferId,
        operationKey,
        deliveryPlanId: trigger.binding.deliveryPlanId,
        queueSessionId,
        messageId: draft.card.messageId,
        targetSubmissionId: `${transferId}:submission`
      },
      {
        stateDirectory: ports.stateDirectory,
        getRecord: deliveryHost.getRecord.bind(deliveryHost),
        getJournal: deliveryHost.getJournal.bind(deliveryHost),
        readPreparationEvidence: deliveryHost.readPreparationEvidence
      },
      ports.now(),
      signal
    )
    signal.throwIfAborted()
    const journal = deliveryHost.getJournal(intent.targetSessionId)
    const record = deliveryHost.getRecord(intent.targetSessionId)
    if (!journal || !record) {
      throw new Error('Continuation target unavailable')
    }
    const source = deliveryHost.getJournal(queueSessionId)
    if (!source) {
      throw new Error('Continuation source unavailable')
    }
    await appendConversationTransfer({
      db,
      source,
      target: journal,
      binding: prepared.binding,
      authority: prepared.authority,
      body: prepared.body,
      options: prepared.options,
      fence: record.lease.runtimeFence,
      now: ports.now(),
      signal,
      isCurrent: (entry) => deliveryHost.getJournal(entry.queuedMessages.sessionId) === entry
    })
    ports.publishSourceQueue(queueSessionId)
    count++
    // Yield without holding any session serializer or database transaction.
    if (count % 32 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
}
