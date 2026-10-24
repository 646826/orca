import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import { appendJournalHostCompound } from '../agent-session-journal/journal-host-compound-writes'
import {
  readPinnedQueuedMessageEvidence,
  assertQueuedDraftCurrentGeneration
} from '../agent-session-journal/queued-message-origin'
import { conversationContextDigest } from '../conversations/conversation-context-consent'
import type { ConversationTriggerBinding } from '../conversations/conversation-trigger-schema'
import {
  conversationTriggerAppendReceipt,
  readConversationTransfer,
  type ConversationTriggerAuthority
} from '../conversations/conversation-trigger-reservation'
import type Database from '../../sqlite/sync-database'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { nextSendableQueuedCard } from '../agent-session-journal/queued-message-pause'

export type ConversationQueueView = {
  queuedMessages: Pick<
    AgentSessionJournal['queuedMessages'],
    'list' | 'pauses' | 'get' | 'evidence'
  > & {
    editLeases: Pick<AgentSessionJournal['queuedMessages']['editLeases'], 'heldIds'>
  }
}
export function readConversationSendableDraft(
  db: Database.Database,
  source: { sessionId: string; conversationId: string; contextGeneration: number },
  getJournal: (id: string) => ConversationQueueView | null
) {
  const journal = getJournal(source.sessionId)
  if (!journal) {
    return null
  }
  const rows = journal.queuedMessages.list()
  const draft = nextSendableQueuedCard(
    journal.queuedMessages.pauses(),
    rows,
    journal.queuedMessages.editLeases.heldIds(rows)
  )
  if (draft) {
    assertQueuedDraftCurrentGeneration(db, {
      sessionId: source.sessionId,
      messageId: draft.messageId
    })
  }
  return draft
}
/** The source retires and the ordinary target submission becomes durable at one commit point. */
export async function appendConversationTransfer(input: {
  db: Database.Database
  source: AgentSessionJournal
  target: AgentSessionJournal
  binding: ConversationTriggerBinding
  authority: ConversationTriggerAuthority
  body: AgentJournalMessageItem
  options?: AgentSessionExecutionOptions
  fence: number
  now: number
  isCurrent: (journal: AgentSessionJournal) => boolean
  validate?: () => void
  signal?: AbortSignal
}) {
  const { source, target, binding } = input
  if (
    source === target ||
    source.queuedMessages.sessionId !== binding.queueSessionId ||
    target.queuedMessages.sessionId !== binding.targetSessionId ||
    binding.messageId === binding.targetSubmissionId
  ) {
    throw new Error('Conversation transfer crossed journal ownership')
  }
  return appendJournalHostCompound(
    [source, target],
    () => {
      const reservation = readConversationTransfer(input.db, binding.transferId)
      if (
        !reservation ||
        conversationContextDigest(reservation.binding) !== conversationContextDigest(binding)
      ) {
        throw new Error('Conversation transfer reservation changed')
      }
      if (reservation.state !== 'reserved') {
        const submitted = target.submission(binding.targetSubmissionId)
        const proof = readPinnedQueuedMessageEvidence(input.db, {
          ownerId: `conversation-transfer:${binding.transferId}`,
          sourceSessionId: binding.queueSessionId,
          messageId: binding.messageId,
          fingerprint: binding.sourceFingerprint
        })
        if (
          !['appended', 'uncertain', 'accepted', 'proven-no-effect'].includes(reservation.state) ||
          !proof ||
          !submitted ||
          submitted.payloadFingerprint !== binding.targetFingerprint ||
          submitted.queuedMessageId !== undefined
        ) {
          throw new Error('Conversation transfer cannot be replayed')
        }
        return {
          appends: [],
          validate: (db) => {
            if (db !== input.db) {
              throw new Error('Conversation transfer crossed host databases')
            }
          }
        }
      }
      const card = source.queuedMessages.get(binding.messageId)
      if (
        !card ||
        card.state !== binding.expectedQueueState ||
        card.fingerprint !== binding.sourceFingerprint
      ) {
        throw new Error('Conversation transfer source changed')
      }
      const withdrawal = source.queuedMessages.plan(
        [{ messageId: binding.messageId, change: { op: 'withdrawn' } }],
        { transferId: binding.transferId }
      )
      const targetPlan = target.planSubmission({
        clientMessageId: binding.targetSubmissionId,
        payloadFingerprint: binding.targetFingerprint,
        body: input.body,
        options: input.options,
        fence: input.fence,
        handoverRecorded: true
      })
      const sourceCursor = source.cursor()
      const receipt = conversationTriggerAppendReceipt({
        binding,
        authority: input.authority,
        originSessionId: binding.targetSessionId,
        now: input.now,
        sourceWithdrawal: {
          epoch: sourceCursor.epoch,
          sequence: sourceCursor.sequence + withdrawal.rows.length
        }
      })
      return {
        appends: [
          { journal: source, ...withdrawal },
          { journal: target, ...targetPlan }
        ],
        receipt,
        receiptRow: (prepared) =>
          prepared
            .find((entry) => entry.journal === target)
            ?.rows.find((row) => row.kind === 'submission'),
        validate: (db) => {
          if (db !== input.db) {
            throw new Error('Conversation transfer crossed host databases')
          }
          input.validate?.()
          if (
            readConversationSendableDraft(
              input.db,
              {
                sessionId: binding.queueSessionId,
                conversationId: binding.conversationId,
                contextGeneration: binding.contextGeneration
              },
              (id) => (id === binding.queueSessionId ? source : null)
            )?.messageId !== binding.messageId
          ) {
            throw new Error('Conversation source queue paused or reordered')
          }
        }
      }
    },
    { isCurrent: input.isCurrent, signal: input.signal }
  )
}
