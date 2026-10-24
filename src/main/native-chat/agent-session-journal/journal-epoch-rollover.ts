import { rollbackJournalEpochReceipts } from './journal-epoch-rollback'
import { assertJournalSynchronousResult } from './journal-write-queue'
import { captureQueuedJournalRowEvidence } from './queued-message-origin'
import type { JournalRowTransactionHook } from './journal-row-writer'
// Opening a new epoch.
//
// One transaction retains pinned history and restates every live queue card in the new epoch.

import { journalRowSchemaVersion } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalLoad } from './journal-open'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { buildJournalQueueRow } from './journal-queue-events'
import type { JournalQueueRestatement } from './journal-queued-messages'
import {
  deleteJournalEpochRows,
  insertJournalRow,
  publishJournalSessionEpoch,
  readJournalSessionEpoch
} from './journal-row-table'
import type { AgentJournalEpochReason, JournalRow } from './journal-row-schema'

export function publishNewEpoch(input: {
  requiredInTransaction?: JournalRowTransactionHook
  database: JournalHostDatabase
  identity: AgentSessionJournalIdentity
  epoch: string
  reason: AgentJournalEpochReason
  fence: number
  now: number
  /** The cards restated in the new epoch; it carries no submission, so a card whose hand-off was
   *  not handed over yet waits again (`retainedQueueFacts`). */
  queue: JournalQueueRestatement
  /** Called the instant the transaction commits, before any fallible follow-up. */
  onPublished: (loaded: JournalLoad) => void
  onCommitted?: () => void
  adoptionFailed?: (error: unknown) => never
  rollbackFailed?: (error: unknown) => void
}): void {
  const row: JournalRow = {
    kind: 'epoch',
    reason: input.reason,
    providerHandle: agentSessionJournalProviderHandle(input.identity),
    // Carries no body: an older host must keep reading a turn-free session past row 1.
    v: journalRowSchemaVersion([]),
    epoch: input.epoch,
    seq: 1,
    fence: input.fence,
    ts: input.now
  }

  const { sessionId } = input.identity
  const state = createJournalReducerState(sessionId, input.epoch)
  applyJournalRow(state, row)
  const rows: JournalRow[] = [row]
  for (const { messageId, change } of input.queue.cards) {
    if (change) {
      const card = buildJournalQueueRow(state, messageId, change, state.lastSequence + 1, input.now)
      applyJournalRow(state, card)
      rows.push(card)
    }
  }
  try {
    input.database.transaction((db) => {
      const retired = readJournalSessionEpoch(db, sessionId)
      for (const each of rows) {
        insertJournalRow(db, sessionId, each)
      }
      assertJournalSynchronousResult(input.queue.receipt.write(db))
      for (const each of rows) {
        captureQueuedJournalRowEvidence(db, sessionId, each)
        assertJournalSynchronousResult(input.requiredInTransaction?.(db, each))
      }
      if (retired !== null) {
        deleteJournalEpochRows(db, sessionId, retired)
      }
      publishJournalSessionEpoch(db, input.identity, input.epoch)
    })
  } catch (error) {
    rollbackJournalEpochReceipts([input.queue.receipt], input.rollbackFailed)
    throw error
  }

  try {
    assertJournalSynchronousResult(input.queue.receipt.committed())
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
