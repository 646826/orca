import type Database from '../../sqlite/sync-database'
import type { ConversationQueueView } from '../agent-session-wire/structured-conversation-source-queue'
import { runJournalTransaction } from '../agent-session-journal/journal-transaction'
import { claimConversationAttachmentInTransaction } from '../agent-session-attachments/conversation-attachment-claims'
import { readSwitchIntent, readConversation } from './conversation-read-model'
import { assertConversationTransferSourceScope } from './conversation-trigger-reservation'
import {
  captureConversationTriggerAttachments,
  conversationTriggerClaimOwner
} from './conversation-trigger-attachments'
import { conversationContextDigest } from './conversation-context-consent'

/** Stage claims before index authorization; final reservation must not mutate its proof revision. */
export async function stageConversationTriggerClaims(
  db: Database.Database,
  request: {
    kind: 'trigger' | 'queued-continuation'
    transferId: string
    operationKey: string
    expectedIntentVersion: number
    queueSessionId: string
    messageId: string
    stateDirectory: string
  },
  now: number,
  signal: AbortSignal,
  getJournal: (sessionId: string) => ConversationQueueView | null
) {
  if (db.isTransaction) {
    throw new Error('Cannot stage attachments in a transaction')
  }
  const input = { ...request }
  const intent = readSwitchIntent(db, input.operationKey)
  const draft = getJournal(input.queueSessionId)?.queuedMessages.get(input.messageId)
  if (
    !intent ||
    intent.version !== input.expectedIntentVersion ||
    !draft ||
    !['waiting', 'returned'].includes(draft.state)
  ) {
    throw new Error('Trigger staging is unavailable')
  }
  const checkOperation = () => {
    const conversation = readConversation(db, intent.conversationId)
    if (
      !conversation ||
      conversation.contextGeneration !== intent.contextGeneration ||
      (input.kind === 'trigger'
        ? conversation.pendingOperationKey !== input.operationKey
        : conversation.pendingOperationKey !== null ||
          conversation.activeSegmentId !== intent.candidateSegmentId ||
          intent.phase !== 'activated')
    ) {
      throw new Error('Trigger staging operation changed')
    }
  }
  checkOperation()
  assertConversationTransferSourceScope(db, { ...intent, queueSessionId: input.queueSessionId })
  const attachments = await captureConversationTriggerAttachments(
    input.stateDirectory,
    draft.body,
    signal
  )
  signal.throwIfAborted()
  const ownerId = conversationTriggerClaimOwner(input.transferId)
  runJournalTransaction(db, () => {
    checkOperation()
    const current = readSwitchIntent(db, input.operationKey)
    const queued = getJournal(input.queueSessionId)?.queuedMessages.get(input.messageId)
    if (
      !current ||
      current.version !== intent.version ||
      current.phase !== intent.phase ||
      !queued ||
      queued.state !== draft.state ||
      queued.fingerprint !== draft.fingerprint
    ) {
      throw new Error('Trigger staging changed')
    }
    assertConversationTransferSourceScope(db, { ...current, queueSessionId: input.queueSessionId })
    for (const attachment of attachments) {
      claimConversationAttachmentInTransaction(db, {
        ownerId,
        sourceSessionId: input.queueSessionId,
        attachment,
        now
      })
    }
  })
  return {
    ownerId,
    attachmentClaimsDigest: conversationContextDigest(attachments),
    sourceFingerprint: draft.fingerprint
  }
}
