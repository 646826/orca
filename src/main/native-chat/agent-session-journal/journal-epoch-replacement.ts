import { rollbackJournalEpochReceipts } from './journal-epoch-rollback'
import { assertJournalSynchronousResult } from './journal-write-queue'
import { captureQueuedJournalRowEvidence } from './queued-message-origin'
import {
  journalItemEchoFields,
  journalItemEchoRestatement,
  type JournalItemEcho
} from './journal-item-echo'
// Republishing a live item set into a fresh epoch.
//
// One transaction retains pinned history and restates items, pending submissions and live cards.

import { sameJournalConversation } from './journal-history-origin'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'

import type {
  AgentJournalCursor,
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalProducerLinkage,
  AgentJournalTurnScope,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalLoad } from './journal-open'
import {
  applyJournalRow,
  createJournalReducerState,
  type JournalReducerState
} from './journal-reducer'
import {
  buildJournalItemRow,
  buildJournalSubmissionRow,
  journalRowBase
} from './journal-row-builders'
import { buildJournalQueueRow } from './journal-queue-events'
import type { JournalQueueRestatement } from './journal-queued-messages'
import {
  buildJournalQueueReopenRow,
  buildJournalQueueClearRow,
  buildJournalQueueResumeRow,
  buildJournalStopEventRow
} from './journal-stop-and-resume-rows'
import type { JournalQueuePauseRestatement } from './queued-message-pause'
import {
  deleteJournalEpochRows,
  insertJournalRow,
  publishJournalSessionEpoch,
  readJournalSessionEpoch
} from './journal-row-table'
import type { AgentJournalEpochReason, JournalRow } from './journal-row-schema'
import { assertJournalFence } from './journal-write-guards'
import type { JournalOperationReceipt, JournalRowTransactionHook } from './journal-row-writer'

export type JournalReplacementItem = AgentJournalProducerLinkage & {
  echoOf?: JournalItemEcho['echoOf']
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  observedAt?: number
  /** Absent for history rebuilt from a source that never stated one: derived from position, as
   *  a legacy row's is, and then written down. */
  turnScope?: AgentJournalTurnScope
  /** Carried from the epoch it came from (`JournalItemRow.ownerFence`), never the replacing
   *  writer's fence: replacing history does not make it the current generation's work. */
  ownerFence: number
  /** Carried the same way (`JournalItemRow.executionOwner`). */
  executionOwner?: number
}

export function replaceJournalEpoch(input: {
  requiredInTransaction?: JournalRowTransactionHook
  database: JournalHostDatabase
  identity: AgentSessionJournalIdentity
  reason: AgentJournalEpochReason
  fence: number
  items: readonly JournalReplacementItem[]
  receipt?: (cursor: AgentJournalCursor) => JournalOperationReceipt
  previous?: JournalReducerState
  /** Restated in the new epoch, or the rewind would release cards the person stopped, or bring
   *  back a /clear pause they already lifted. */
  queuePause: JournalQueuePauseRestatement
  /** The cards restated ahead of the carried submissions, which relink theirs. */
  queue: JournalQueueRestatement
  now: () => number
  mintEpoch: () => string
  /** Called the instant the transaction commits, before any fallible follow-up. */
  onPublished: (loaded: JournalLoad) => void
  onCommitted?: () => void
  adoptionFailed?: (error: unknown) => never
  rollbackFailed?: (error: unknown) => void
}): void {
  const epoch = input.mintEpoch()
  const state = createJournalReducerState(input.identity.sessionId, epoch)
  const providerHandle = agentSessionJournalProviderHandle(input.identity)
  const previousOrigin = input.previous?.historyOrigin
  const restate =
    input.reason !== 'legacy_import' &&
    input.reason !== 'session_created' &&
    previousOrigin &&
    sameJournalConversation(previousOrigin.providerHandle, providerHandle)
  const epochRow: JournalRow = {
    kind: 'epoch',
    reason:
      input.reason === 'legacy_import' && input.items.length === 0
        ? 'session_created'
        : input.reason,
    providerHandle,
    ...(restate ? { historyOrigin: previousOrigin.raw } : {}),
    ...journalRowBase(epoch, 1, input.fence, input.now())
  }
  const rows: JournalRow[] = [epochRow]
  applyJournalRow(state, epochRow)
  for (const item of input.items) {
    const key =
      input.previous?.aliases.get(agentJournalItemKey(item.identity)) ??
      agentJournalItemKey(item.identity)
    if (input.previous?.items.has(key) && input.previous.itemFences.get(key) !== item.ownerFence) {
      throw new Error('journal replacement item owner changed')
    }
    const row = buildJournalItemRow({
      state,
      identity: item.identity,
      body: item.body,
      ...journalItemEchoFields(item),
      ...(input.previous && input.reason !== 'legacy_import' && input.reason !== 'session_created'
        ? journalItemEchoRestatement(
            input.previous.itemEchoes,
            input.previous.aliases.get(agentJournalItemKey(item.identity)) ??
              agentJournalItemKey(item.identity)
          )
        : {}),
      seq: state.lastSequence + 1,
      fence: input.fence,
      ownerFence: item.ownerFence,
      executionOwner: item.executionOwner,
      ts: item.observedAt ?? input.now(),
      linkage: item,
      turnScope: item.turnScope ?? state.derivedTurnScope.scopeFor(item.body)
    })
    assertJournalFence(row.fence, state.highestFence)
    applyJournalRow(state, row)
    rows.push(row)
  }
  for (const { messageId, change } of input.queue.cards) {
    if (change) {
      const row = buildJournalQueueRow(
        state,
        messageId,
        change,
        state.lastSequence + 1,
        input.now()
      )
      applyJournalRow(state, row)
      rows.push(row)
    }
  }
  // An accepted message that never reached the agent survives a provider history replacement.
  const queued = [...(input.previous?.submissions.values() ?? [])]
    .filter(isQueuedAgentJournalSubmission)
    .sort((a, b) => (a.acceptedSequence ?? 0) - (b.acceptedSequence ?? 0))
  for (const submission of queued) {
    const body = input.previous?.items.get(
      agentJournalSubmissionKey(submission.clientMessageId)
    )?.body
    if (body?.kind !== 'message') {
      throw new Error('journal_queued_submission_body_missing')
    }
    const row = buildJournalSubmissionRow({
      ...submission,
      state,
      body,
      providerHandle: agentSessionJournalProviderHandle(input.identity),
      seq: state.lastSequence + 1,
      fence: input.fence,
      ts: submission.submittedAt
    })
    applyJournalRow(state, row)
    rows.push(row)
  }
  const { lifted, liveStop, reopened } = input.queuePause
  const place = () => ({ state, seq: state.lastSequence + 1, fence: input.fence, ts: input.now() })
  if (lifted) {
    const row = buildJournalQueueResumeRow(place())
    applyJournalRow(state, row)
    rows.push(row)
  }
  if (liveStop) {
    const row = buildJournalStopEventRow({ ...place(), event: liveStop })
    applyJournalRow(state, row)
    rows.push(row)
  }
  if (reopened) {
    const row = buildJournalQueueReopenRow(place())
    applyJournalRow(state, row)
    rows.push(row)
  }
  if (input.queuePause.cleared) {
    const row = buildJournalQueueClearRow({ ...place(), clear: input.queuePause.cleared })
    applyJournalRow(state, row)
    rows.push(row)
  }

  const { sessionId } = input.identity
  const receipt = input.receipt?.({ epoch, sequence: state.lastSequence })
  try {
    input.database.transaction((db) => {
      const retired = readJournalSessionEpoch(db, sessionId)
      if (retired !== null) {
        const endSequence = db
          .prepare(
            'SELECT MAX(seq) AS end_sequence FROM journal_rows WHERE session_id = ? AND epoch = ?'
          )
          .get(sessionId, retired)?.end_sequence
        if (
          retired === epoch ||
          typeof endSequence !== 'number' ||
          !Number.isSafeInteger(endSequence) ||
          endSequence < 1 ||
          (input.previous &&
            (input.previous.epoch !== retired || input.previous.lastSequence !== endSequence))
        ) {
          throw new Error('journal replacement source changed')
        }
        // Capture under the same writer transaction as retirement/publication. The reducer
        // ignores this structural provenance; archived readers require this exact boundary.
        epochRow.replacementOf = { epoch: retired, endSequence }
      } else if (input.previous && input.previous.lastSequence > 0) {
        throw new Error('journal replacement source changed')
      }
      for (const row of rows) {
        insertJournalRow(db, sessionId, row)
      }
      assertJournalSynchronousResult(input.queue.receipt.write(db))
      assertJournalSynchronousResult(receipt?.write(db))
      for (const row of rows) {
        captureQueuedJournalRowEvidence(db, sessionId, row)
        const prior =
          row.kind === 'item' && input.previous
            ? input.previous.items.get(input.previous.aliases.get(row.itemId) ?? row.itemId)
            : undefined
        assertJournalSynchronousResult(
          input.requiredInTransaction?.(
            db,
            row,
            prior && input.previous
              ? {
                  previousSource: {
                    epoch: input.previous.epoch,
                    sequence: prior.sequence,
                    ...(prior.sequenceIndex === undefined
                      ? {}
                      : { batchIndex: prior.sequenceIndex })
                  }
                }
              : undefined
          )
        )
      }
      if (retired !== null) {
        deleteJournalEpochRows(db, sessionId, retired)
      }
      publishJournalSessionEpoch(db, input.identity, epoch)
    })
  } catch (error) {
    rollbackJournalEpochReceipts([input.queue.receipt, receipt], input.rollbackFailed)
    throw error
  }
  try {
    assertJournalSynchronousResult(input.queue.receipt.committed())
    assertJournalSynchronousResult(receipt?.committed())
    state.oldestSequence = 1
    assertJournalSynchronousResult(input.onPublished({ state, newer: null, damage: null }))
  } catch (error) {
    input.adoptionFailed?.(error)
    throw error
  }
  try {
    assertJournalSynchronousResult(input.onCommitted?.())
  } catch (error) {
    console.warn('[journal-epoch] committed observer failed', error)
  }
}
