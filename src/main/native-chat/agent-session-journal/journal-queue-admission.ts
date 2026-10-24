import { journalQueueRowBuilder } from './journal-queue-events'
import type { JournalReducerState } from './journal-reducer'
import type { LegacyQueuedCards } from './journal-queue-import'
import type { JournalQueuePlan } from './journal-queued-messages'
import type Database from '../../sqlite/sync-database'
import type { JournalQueueCardChange } from './journal-queue-events'
import { composeJournalOperationReceipts, type JournalOperationReceipt } from './journal-row-writer'
import type { QueuedMessageRow } from './queued-message-table'
import {
  assertQueuedDraftCurrentGeneration,
  assertQueuedDraftOrdinaryAction,
  assertQueuedMessageUnreserved,
  readQueuedMessageEvidence
} from './queued-message-origin'

export function queueMutationReceipt(
  sessionId: string,
  changes: readonly JournalQueueCardChange[],
  transferId?: string
): JournalOperationReceipt {
  return {
    write: (db) => {
      for (const { messageId, change } of changes) {
        if (!change || change.op === 'held') {
          continue
        }
        assertQueuedMessageUnreserved(db, sessionId, messageId, transferId)
        if (change.op === 'edited' || change.op === 'moved') {
          if (transferId === undefined) {
            assertQueuedDraftOrdinaryAction(db, { sessionId, messageId })
          } else {
            assertQueuedDraftCurrentGeneration(db, { sessionId, messageId })
          }
        }
      }
    },
    committed: () => {}
  }
}

export function queueAdmissionEvidence(
  db: Database.Database,
  sourceSessionId: string,
  card: QueuedMessageRow | null
): { sourceSessionId: string; admittedAt: number | null; card: QueuedMessageRow } | null {
  if (!card) {
    return null
  }
  const proof = readQueuedMessageEvidence(db, {
    sourceSessionId,
    messageId: card.messageId,
    fingerprint: card.fingerprint
  })
  return proof ? { sourceSessionId, admittedAt: proof.admittedAt, card } : null
}

export function assertQueueConsumableAdmission(
  db: Database.Database,
  sessionId: string,
  messageId: string
): void {
  assertQueuedDraftOrdinaryAction(db, { sessionId, messageId })
  assertQueuedMessageUnreserved(db, sessionId, messageId)
}

export function planJournalQueueChanges(
  state: () => JournalReducerState,
  legacy: LegacyQueuedCards,
  sessionId: string,
  changes: readonly JournalQueueCardChange[],
  transferId?: string
): JournalQueuePlan {
  const rows: JournalQueuePlan['rows'] = []
  const adopted: string[] = []
  for (const { messageId, change } of changes) {
    const own = state().queue.cards.has(messageId) || adopted.includes(messageId)
    const adoption = own ? null : legacy.adoption(messageId)
    if (adoption) {
      rows.push(journalQueueRowBuilder(state, messageId, adoption))
      adopted.push(messageId)
    }
    if (change) {
      rows.push(journalQueueRowBuilder(state, messageId, change))
    }
  }
  return {
    rows,
    receipt: composeJournalOperationReceipts(
      legacy.deletion(adopted),
      queueMutationReceipt(sessionId, changes, transferId)
    )
  }
}
