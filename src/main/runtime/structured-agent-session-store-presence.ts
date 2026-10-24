import { existsSync } from 'node:fs'
import { journalDatabasePath } from '../native-chat/agent-session-journal/journal-host-database'
import { journalDatabaseHoldsAgentSessions } from '../native-chat/agent-session-journal/journal-database'

/** Whether this profile holds a structured chat: a record or tab in the journal database. */
export function hasPersistedStructuredAgentSessionStore(
  stateDirectory: string,
  fileExists: (path: string) => boolean = existsSync
): boolean {
  const databasePath = journalDatabasePath(stateDirectory)
  if (!fileExists(databasePath)) {
    return false
  }
  try {
    return journalDatabaseHoldsAgentSessions(databasePath)
  } catch {
    // A database that cannot be read cannot say it is empty.
    return true
  }
}
