import type Database from '../../sqlite/sync-database'
import type { ConversationPreparationTrigger } from '../agent-session-wire/structured-conversation-switch-runtime-contracts'
import {
  readQueuedMessageEvidence,
  readPinnedQueuedMessageEvidence
} from '../agent-session-journal/queued-message-origin'
import type { ConversationQueueView } from '../agent-session-wire/structured-conversation-source-queue'
import {
  readConversationTransfer,
  assertConversationTransferSourceScope
} from './conversation-trigger-reservation'
import { readSwitchIntent } from './conversation-read-model'
import { readConversationTriggerAttachments } from './conversation-trigger-attachments'
import { conversationContextDigest } from './conversation-context-consent'

export function assertConversationPreparationTrigger(
  db: Database.Database,
  trigger: ConversationPreparationTrigger | null,
  operationKey: string,
  getJournal: (sessionId: string) => ConversationQueueView | null
): void {
  if (!trigger) {
    return
  }
  const intent = readSwitchIntent(db, operationKey)
  if (!intent || trigger.queueSessionId === intent.targetSessionId) {
    throw new Error('Preparation trigger scope changed')
  }
  assertConversationTransferSourceScope(db, { ...intent, queueSessionId: trigger.queueSessionId })
  const queued = getJournal(trigger.queueSessionId)?.queuedMessages.get(trigger.messageId)
  const transfer = readConversationTransfer(db, trigger.transferId)
  const bound = transfer?.binding
  if (
    bound &&
    (transfer.state === 'cancelled' ||
      bound.kind !== 'trigger' ||
      bound.operationKey !== operationKey ||
      bound.conversationId !== intent.conversationId ||
      bound.contextGeneration !== intent.contextGeneration ||
      bound.candidateGeneration !== intent.activationFence ||
      bound.targetSessionId !== intent.targetSessionId ||
      bound.sourceFingerprint !== trigger.sourceFingerprint ||
      bound.queueSessionId !== trigger.queueSessionId ||
      bound.messageId !== trigger.messageId ||
      bound.attachmentClaimsDigest !== trigger.attachmentClaimsDigest ||
      bound.targetOptionsDigest !== trigger.targetOptionsDigest)
  ) {
    throw new Error('Preparation trigger binding changed')
  }
  const transferred =
    bound && ['appended', 'uncertain', 'accepted', 'proven-no-effect'].includes(transfer.state)
  const evidenceInput = {
    sourceSessionId: trigger.queueSessionId,
    messageId: trigger.messageId,
    fingerprint: trigger.sourceFingerprint
  }
  const proof = bound
    ? readPinnedQueuedMessageEvidence(db, {
        ...evidenceInput,
        ownerId: `conversation-transfer:${trigger.transferId}`
      })
    : readQueuedMessageEvidence(db, evidenceInput)
  if (
    (bound && !proof) ||
    (!transferred &&
      (!queued ||
        !['waiting', 'returned'].includes(queued.state) ||
        queued.fingerprint !== trigger.sourceFingerprint)) ||
    conversationContextDigest(readConversationTriggerAttachments(db, trigger.transferId)) !==
      trigger.attachmentClaimsDigest
  ) {
    throw new Error('Preparation trigger changed')
  }
}
