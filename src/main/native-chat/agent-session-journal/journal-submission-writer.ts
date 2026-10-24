// A sent message's rows: its write-ahead submission and each dispatch transition, with what must
// commit in the same transaction (a queued card's hand-off, the send's ledger answer, a kept card).

import type {
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { journalDispatchRowApplies } from './journal-dispatch-settlement'
import type { JournalQueuedMessages, JournalQueuePlan } from './journal-queued-messages'
import type { JournalAttachmentClaim } from './journal-submission-hook'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalReducerState } from './journal-reducer'
import {
  buildJournalTombstoneRow,
  journalDispatchRowBuilder,
  journalSubmissionRowBuilder
} from './journal-row-builders'
import type { JournalRow } from './journal-row-schema'
import {
  composeJournalOperationReceipts,
  type JournalOperationReceipt,
  type JournalRowWriter
} from './journal-row-writer'
import type {
  JournalSubmissionConsume,
  JournalSubmissionInput,
  ResolveDispatchInput
} from './journal-store-contracts'

export type JournalSubmissionWriterDeps = {
  state: () => JournalReducerState
  identity: AgentSessionJournalIdentity
  database: () => JournalHostDatabase
  rowWriter: JournalRowWriter
  queuedMessages: JournalQueuedMessages
  claimAttachments: JournalAttachmentClaim
}

export class JournalSubmissionWriter {
  constructor(private readonly deps: JournalSubmissionWriterDeps) {}

  /**
   * Write-ahead submission row. It is durable before the caller dispatches
   * anything, and it doubles as the optimistic user bubble so an accepted echo
   * reconciles into an existing slot instead of appending a second copy.
   */
  append(
    input: JournalSubmissionInput,
    /** Present: this submission hands off a queued card. The row naming it IS the hand-off, checked
     *  against the card at its turn on the lane: one id, one delivery. */
    consume?: JournalSubmissionConsume,
    /** The send's ledger answer, committed with this row. */
    receipt?: JournalOperationReceipt
  ): Promise<AgentJournalCursor> {
    let planned: ReturnType<JournalSubmissionWriter['plan']> | undefined
    return this.deps.rowWriter
      .enqueueRows(
        () => {
          planned = this.plan(input, consume)
          return planned.rows
        },
        composeJournalOperationReceipts(
          {
            write: (db, row) => planned?.receipt.write(db, row),
            committed: () => planned?.receipt.committed(),
            rolledBack: () => planned?.receipt.rolledBack?.()
          },
          ...(receipt ? [receipt] : [])
        ),
        (rows) => rows.at(-1)
      )
      .then(rowCursor)
  }

  /** Plans only, on an already owned lane; the compound owner performs the write and adoption. */
  plan(input: JournalSubmissionInput, consume?: JournalSubmissionConsume) {
    const { claimAttachments, identity, queuedMessages, state } = this.deps
    const submission = journalSubmissionRowBuilder(state, identity, input, consume)
    let card: JournalQueuePlan | undefined
    if (consume) {
      queuedMessages.assertConsumable({
        ...consume,
        consumedAs: input.clientMessageId,
        fingerprint: input.payloadFingerprint
      })
      card = queuedMessages.plan([{ messageId: consume.messageId }])
    }
    const receipt = composeJournalOperationReceipts(...(card ? [card.receipt] : []), {
      write: (db) => claimAttachments(db, input.body, input.origin === 'client' && !consume),
      committed: () => {}
    })
    return {
      rows: [...(card?.rows ?? []), submission],
      receipt,
      receiptRow: (rows: readonly JournalRow[]) => rows.at(-1)
    }
  }

  /** A compound recovery must supply durable no-write authority before committing this retirement. */
  planRetireSubmission(
    clientMessageId: string,
    fence: number,
    historical?: { epoch: string; sequence: number; payloadFingerprint: string }
  ) {
    return [
      (seq: number, ts: number): JournalRow => {
        const state = this.deps.state()
        const submission = state.submissions.get(clientMessageId)
        if (historical) {
          const retained = this.deps
            .database()
            .db.prepare(`SELECT 1 AS present FROM journal_rows
            WHERE session_id=? AND epoch=? AND seq=?
            AND json_extract(row_json,'$.kind')='submission'
            AND json_extract(row_json,'$.clientMessageId')=?
            AND json_extract(row_json,'$.payloadFingerprint')=?
            AND json_extract(row_json,'$.queuedMessageId') IS NULL
            AND json_extract(row_json,'$.epoch')=? AND json_extract(row_json,'$.seq')=?`)
            .get(
              this.deps.identity.sessionId,
              historical.epoch,
              historical.sequence,
              clientMessageId,
              historical.payloadFingerprint,
              historical.epoch,
              historical.sequence
            )
          if (
            !retained ||
            (submission &&
              (state.epoch !== historical.epoch ||
                submission.submittedSequence !== historical.sequence ||
                submission.payloadFingerprint !== historical.payloadFingerprint))
          ) {
            throw new Error('submission retirement historical identity changed')
          }
        }
        if (
          submission
            ? submission.dispatchState !== 'rejected' || submission.queuedMessageId !== undefined
            : !historical || state.epoch === historical.epoch
        ) {
          throw new Error('only a rejected unlinked submission can be retired by compound recovery')
        }
        return {
          ...buildJournalTombstoneRow({
            state,
            itemId: agentJournalSubmissionKey(clientMessageId),
            seq,
            ts,
            fence
          }),
          retireSubmission: true
        }
      }
    ]
  }

  /**
   * Record a dispatch transition, including a proven retry returning to pending.
   *
   * Accepting REQUIRES the provider identity rather than a free-form id: the
   * adopted key is what the provider's echo will upsert into, so a mismatched
   * string here would silently give the user a second copy of their own message.
   * `cards` commit with the row, or roll it back by throwing.
   */
  resolveDispatch(
    input: ResolveDispatchInput,
    /** Card rows that commit with this one, planned at its turn on the lane. */
    cards?: () => JournalQueuePlan,
    receipt?: JournalOperationReceipt
  ): Promise<AgentJournalCursor> {
    const dispatch = journalDispatchRowBuilder(this.deps.state, input)
    if (!cards) {
      return this.deps.rowWriter.append(dispatch, receipt)
    }
    let planned: JournalQueuePlan | undefined
    return this.deps.rowWriter
      .enqueueRows(
        () => {
          planned = cards()
          return [dispatch, ...planned.rows]
        },
        composeJournalOperationReceipts(
          {
            write: (db) => planned?.receipt.write(db),
            committed: () => planned?.receipt.committed(),
            rolledBack: () => planned?.receipt.rolledBack?.()
          },
          ...(receipt ? [receipt] : [])
        ),
        (rows) => rows[0]
      )
      .then((rows) => rowCursor(rows.slice(0, 1)))
  }

  /** A provider's late receipt, decided at its turn in the queue: a send a write ahead of it
   *  already settled gets no row, so repeated receipts save and publish once. */
  async acceptLate(input: Extract<ResolveDispatchInput, { state: 'accepted' }>): Promise<void> {
    const { rowWriter, state } = this.deps
    await rowWriter.enqueueRows(() =>
      journalDispatchRowApplies(state().submissions.get(input.clientMessageId))
        ? [journalDispatchRowBuilder(state, input)]
        : []
    )
  }
}

/** Where the last of the rows landed: the submission, or the dispatch row. */
function rowCursor(rows: readonly JournalRow[]): AgentJournalCursor {
  const row = rows.at(-1)
  if (!row) {
    throw new Error('agent_session_journal_row_unwritten')
  }
  return { epoch: row.epoch, sequence: row.seq }
}
