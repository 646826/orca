import { randomUUID } from 'node:crypto'
import type { ConversationWorkspaceObservation } from '../../shared/conversation-workspace-observation'
export { compareWorkspaceWatchObservation } from '../../shared/conversation-workspace-observation'

export type WorkspaceWatchOwner = { readonly rootPath: string }

type Observation = Omit<ConversationWorkspaceObservation, 'scopeDigest'>
// Metadata dies with the existing root; this creates neither watchers nor path/event history.
const observations = new WeakMap<WorkspaceWatchOwner, Observation>()
function observation(root: WorkspaceWatchOwner): Observation {
  let value = observations.get(root)
  if (!value) {
    value = { watchIdentity: randomUUID(), revision: 0, continuity: 'observed' }
    observations.set(root, value)
  }
  return value
}
export function recordWorkspaceWatchEvents(root: WorkspaceWatchOwner, interrupted: boolean): void {
  const value = observation(root)
  if (value.revision === Number.MAX_SAFE_INTEGER || interrupted) {
    value.continuity = 'unknown'
  }
  if (value.revision < Number.MAX_SAFE_INTEGER) {
    value.revision++
  }
}
export function readWorkspaceWatchObservation(
  root: WorkspaceWatchOwner | null,
  scopeDigest: string
): ConversationWorkspaceObservation {
  return root
    ? { ...observation(root), scopeDigest }
    : {
        scopeDigest,
        watchIdentity: null,
        revision: 0,
        continuity: 'unknown'
      }
}
