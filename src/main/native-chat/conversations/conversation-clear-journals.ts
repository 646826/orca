import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { appendJournalHostCompound } from '../agent-session-journal/journal-host-compound-writes'
import { composeJournalOperationReceipts } from '../agent-session-journal/journal-row-writer'
import type { JournalQueueCardChange } from '../agent-session-journal/journal-queue-events'
import type { ConversationClearStore } from './conversation-clear-store'
import { ConversationRefusal } from './conversation-read-model'

export function appendConversationClearJournals(input: {
  journals: readonly AgentSessionJournal[]
  clear: ConversationClearStore
  activeSessionId: string
  operationKey: string
  expectedVersion: number
  now: number
  isCurrent: (journal: AgentSessionJournal) => boolean
  validate?: () => void
  signal?: AbortSignal
}) {
  return appendJournalHostCompound(
    input.journals,
    () => {
      const intent = input.clear.intent(input.operationKey)
      const ids = input.journals.map((journal) => journal.queuedMessages.sessionId).sort()
      if (
        !intent ||
        intent.version !== input.expectedVersion ||
        intent.phase !== 'prepared' ||
        ids.length !== intent.participants.length ||
        ids.some((id, index) => id !== intent.participants.map((p) => p.sessionId).sort()[index]) ||
        !ids.includes(input.activeSessionId)
      ) {
        throw new ConversationRefusal('stale-generation')
      }
      input.signal?.throwIfAborted()
      const appends = input.journals.map((journal) => {
        const activeClear =
          journal.queuedMessages.sessionId === input.activeSessionId
            ? journal.context.planClear(input.clear.boundary(input.operationKey, input.now))
            : null
        const changes: JournalQueueCardChange[] = journal.queuedMessages
          .list()
          .flatMap((card): JournalQueueCardChange[] => {
            if (card.body.command) {
              return !activeClear && (card.state === 'waiting' || card.state === 'returned')
                ? [{ messageId: card.messageId, change: { op: 'withdrawn' } }]
                : []
            }
            return card.state === 'waiting'
              ? [
                  {
                    messageId: card.messageId,
                    change: { op: 'held', holdReason: 'context_generation_changed' }
                  }
                ]
              : []
          })
        const held = journal.queuedMessages.plan(changes)
        return {
          journal,
          rows: [...(activeClear?.rows ?? []), ...held.rows],
          receipt: composeJournalOperationReceipts(
            ...(activeClear ? [activeClear.receipt] : []),
            held.receipt
          )
        }
      })
      const journalAppends = appends.map(({ journal, rows }) => ({
        sessionId: journal.queuedMessages.sessionId,
        epoch: journal.cursor().epoch,
        firstSequence: journal.cursor().sequence + 1,
        rowCount: rows.length
      }))
      return {
        appends,
        receipt: input.clear.receipt({
          operationKey: input.operationKey,
          expectedVersion: input.expectedVersion,
          now: input.now,
          journalAppends
        }),
        receiptRow: (prepared) =>
          prepared.find(({ journal }) => journal.queuedMessages.sessionId === input.activeSessionId)
            ?.rows[0],
        validate: () => {
          input.signal?.throwIfAborted()
          input.validate?.()
        }
      }
    },
    { isCurrent: input.isCurrent, signal: input.signal }
  )
}
