import { isAbsolute, resolve } from 'node:path'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { readRuntimeWorkspaceWatchObservation } from './file-watcher-host'
import { findCoveringLocalWatchRoot } from '../ipc/local-watcher-event-observers'
import { readWorkspaceWatchObservation } from './workspace-watch-observation'
import { conversationContextDigest } from '../native-chat/conversations/conversation-context-consent'
import { agentSessionPinnedLaunchDirectory } from './agent-session-record-launch-directory'

/** Bounded root-resolution cache, not a workspace ownership or file-content store. */
export function createConversationWorkspaceObserver(
  resolveWorkspacePath: ((workspaceId: string) => Promise<string>) | undefined
) {
  const roots = new Map<string, string>()
  const key = (record: AgentSessionRecord) =>
    conversationContextDigest({
      location: record.location,
      launchDirectory: agentSessionPinnedLaunchDirectory(record) ?? null
    })
  return {
    async resolve(record: AgentSessionRecord, signal: AbortSignal) {
      signal.throwIfAborted()
      const scope = key(record)
      const pinned = agentSessionPinnedLaunchDirectory(record)
      let directory: string | undefined
      try {
        directory = pinned ?? (await resolveWorkspacePath?.(record.location.workspaceId))
      } catch {
        roots.delete(scope)
        signal.throwIfAborted()
        return
      }
      signal.throwIfAborted()
      if (!directory || !isAbsolute(directory) || record.location.wslDistro !== null) {
        roots.delete(scope)
        return
      }
      if (roots.size >= 128 && !roots.has(scope)) {
        const first = roots.keys().next().value
        if (first !== undefined) {
          roots.delete(first)
        }
      }
      roots.set(scope, resolve(directory))
    },
    read(record: AgentSessionRecord) {
      const directory = roots.get(key(record))
      const scope = conversationContextDigest({
        location: record.location,
        directory: directory ?? null
      })
      if (!directory) {
        return readWorkspaceWatchObservation(null, scope)
      }
      const runtime = readRuntimeWorkspaceWatchObservation(directory, scope)
      if (runtime.watchIdentity !== null) {
        return runtime
      }
      const local = findCoveringLocalWatchRoot(directory)
      // Ancestor coverage can include unrelated nested workspaces; do not claim exact observation.
      return readWorkspaceWatchObservation(
        local && resolve(local.rootPath) === directory ? local : null,
        scope
      )
    }
  }
}
