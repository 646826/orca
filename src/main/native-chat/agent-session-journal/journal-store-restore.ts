// Bringing a store's in-memory state up from disk.
//
// Split out of the store for the same reason its collaborators were: this is the
// ORDERING between replay and the notices an open owes, and none of it belongs
// to the store's public surface. Every step here reads or writes through the
// same host the collaborators use, so the store keeps the state and this owns
// the sequence.

import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { JournalEpochController } from './journal-epoch-controller'
import { replayJournal, type JournalLoad } from './journal-open'
import { failLoadOnUnloadableJournal, journalOpenRefusalError } from './journal-open-failure'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalStoreHost } from './journal-store-collaborators'
import { openJournalStoreState } from './journal-store-open'
import { AgentSessionJournalError } from './journal-write-guards'

/** An older cached fold lacks this derived field; only verified replay can reconstruct it. */
export function restoreJournalTailFence(
  database: JournalHostDatabase,
  sessionId: string,
  loaded: JournalLoad
): JournalLoad {
  if (Number.isSafeInteger(loaded.state.lastRowFence) && loaded.state.lastRowFence >= 0) {
    return loaded
  }
  const replayed = replayJournal(database.db, sessionId)
  if (!replayed) {
    throw new Error('journal tail fence requires durable replay')
  }
  failLoadOnUnloadableJournal(sessionId, replayed)
  return replayed
}

export async function restoreJournalStore(
  host: JournalStoreHost,
  collaborators: { epochController: JournalEpochController }
): Promise<void> {
  const database = host.database()
  if (database.readOnly) {
    // A newer Orca's database: nothing in it is read as this build's, and nothing is written.
    throw journalOpenRefusalError(
      new AgentSessionJournalError(
        'journal_read_only',
        `agent-session journal for ${host.identity.sessionId} is in a newer Orca's database`
      )
    )
  }
  return openJournalStoreState({
    sessionId: host.identity.sessionId,
    replay: () => replayJournal(database.db, host.identity.sessionId),
    start: () => collaborators.epochController.start('session_created', 0),
    adopt: (loaded) => {
      host.adopt(loaded)
      host.notifyCommitted()
    },
    // Journal-open revisions are host recovery, not new provider output.
    appendItem: (identity, body, fence) =>
      host.journal().appendItem(identity, body, {
        fence,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE,
        recovered: true
      }),
    highestFence: () => host.state().highestFence
  })
}
