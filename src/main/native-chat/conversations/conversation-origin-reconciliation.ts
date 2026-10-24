import { setImmediate } from 'node:timers/promises'
import type Database from '../../sqlite/sync-database'
import { runJournalTransaction } from '../agent-session-journal/journal-transaction'
import { resolveConversationOrigins } from './conversation-origin-rows'
import { resolveConversationOriginCorrelations } from './conversation-origin-correlation'

/** Drain known causal aliases in bounded phases; unknown evidence remains a handoff blocker. */
export async function reconcileConversationOrigins(
  db: Database.Database,
  sessionId: string,
  signal: AbortSignal
): Promise<void> {
  if (db.isTransaction) {
    throw new Error('Origin reconciliation cannot wait in a transaction')
  }
  for (;;) {
    signal.throwIfAborted()
    const counts = runJournalTransaction(db, () => ({
      correlations: resolveConversationOriginCorrelations(db, sessionId, 128),
      rows: resolveConversationOrigins(db, sessionId, 128)
    }))
    if (counts.correlations < 128 && counts.rows < 128) {
      return
    }
    await setImmediate(undefined, { signal })
  }
}
