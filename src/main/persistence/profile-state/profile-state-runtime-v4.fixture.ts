// Runtime admission from aecb9924858d9c34adeea704b8593fd25c0b1f01, before migration guards.
import {
  profileStateAccessPaths,
  publishAccessOwner,
  reclaimExitedOwner
} from './profile-state-access-owner'
export { openJournalDatabase } from '../../native-chat/agent-session-journal/journal-database-v4.fixture'

export function acquireProfileStateRuntimeAdmission(userDataPath: string) {
  const paths = profileStateAccessPaths(userDataPath)
  const owner = publishAccessOwner(paths, false)
  try {
    reclaimExitedOwner(paths.maintenance)
    return owner
  } catch (error) {
    owner.release()
    throw error
  }
}
