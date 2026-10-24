import type { AgentSessionProviderContextBoundary } from '../../../shared/agent-session-provider-context'
import type { JournalReducerState } from './journal-reducer'
import { journalItemRowBuilder } from './journal-row-builders'
import {
  composeJournalOperationReceipts,
  type JournalOperationReceipt,
  type JournalRowWriter
} from './journal-row-writer'
import type { JournalQueuedMessages } from './journal-queued-messages'
import type { JournalRow, JournalTombstoneRow } from './journal-row-schema'
import { buildJournalQueueClearRow } from './journal-stop-and-resume-rows'

export function planJournalContextClear(input: {
  state: () => JournalReducerState
  cards: JournalQueuedMessages
  boundary: AgentSessionProviderContextBoundary
}): { rows: ((seq: number, ts: number) => JournalRow)[]; receipt: JournalOperationReceipt } {
  const { boundary, state } = input
  const cards = input.cards.list()
  const commands = input.cards.plan(
    cards
      .filter(
        (card) => card.body.command && (card.state === 'waiting' || card.state === 'returned')
      )
      .map((card) => ({ messageId: card.messageId, change: { op: 'withdrawn' as const } }))
  )
  const messageIds = cards
    .filter((card) => card.state === 'waiting' && !card.body.command)
    .map((card) => card.messageId)
  return {
    rows: [
      journalItemRowBuilder(
        state,
        { provider: 'orca', clientMessageId: `context-clear:${boundary.operationId}` },
        {
          kind: 'status',
          text: 'Context cleared',
          presentation: 'context-cleared',
          contextClear: boundary
        },
        { fence: boundary.afterFence, turnScope: { kind: 'thread' } }
      ),
      (seq: number, ts: number): JournalTombstoneRow =>
        buildJournalQueueClearRow({
          state: state(),
          seq,
          ts,
          fence: boundary.afterFence,
          clear: { operationId: boundary.operationId, messageIds }
        }),
      ...commands.rows
    ],
    receipt: commands.receipt
  }
}

export function appendJournalContextClear(input: {
  state: () => JournalReducerState
  writer: JournalRowWriter
  cards: JournalQueuedMessages
  boundary: AgentSessionProviderContextBoundary
  receipt: JournalOperationReceipt
}) {
  let planned: ReturnType<typeof planJournalContextClear> | undefined
  return input.writer
    .enqueueRows(
      () => {
        planned = planJournalContextClear(input)
        return planned.rows
      },
      {
        write: (db, row) => {
          if (!planned) {
            throw new Error('Context clear was not planned')
          }
          composeJournalOperationReceipts(planned.receipt, input.receipt).write(db, row)
        },
        committed: () => {
          planned?.receipt.committed()
          input.receipt.committed()
        },
        rolledBack: () => {
          planned?.receipt.rolledBack?.()
          input.receipt.rolledBack?.()
        }
      },
      (rows) => rows[0]
    )
    .then((rows) => ({
      epoch: input.state().epoch,
      sequence: rows.at(-1)?.seq ?? input.state().lastSequence
    }))
}
