import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { AppState } from '../store/types'
import type { ClosedConversationTab } from './conversation-tab-visibility'
import { executionHostIdForStructuredTarget } from './structured-agent-session-owner'
import { captureWorktreeOperationGenerationGuard } from '@/lib/worktree-operation-generation'
import { resolveWorktreeOperationRouteForHost } from '@/lib/worktree-operation-route'

const pending = new Set<{
  workspaceId: string
  host: ExecutionHostId
  controller: AbortController
}>()
/** Ephemeral request lifetime only; completed views remain owned by the host surface record. */
export function captureConversationTabLifetime(get: () => AppState, ref: ClosedConversationTab) {
  const host = executionHostIdForStructuredTarget(ref.target)
  const resolve = () => resolveWorktreeOperationRouteForHost(get(), ref.workspaceId, host)
  const route = resolve()
  if (!route) {
    throw new Error('Conversation workspace unavailable')
  }
  const guard = captureWorktreeOperationGenerationGuard(
    get,
    ref.workspaceId,
    route,
    () => new Error('Conversation workspace changed'),
    resolve
  )
  const entry = { workspaceId: ref.workspaceId, host, controller: new AbortController() }
  pending.add(entry)
  const assertCurrent = () => {
    entry.controller.signal.throwIfAborted()
    guard.assertCurrent()
  }
  return {
    signal: entry.controller.signal,
    assertCurrent,
    canRetainReference() {
      // A reconnect invalidates dispatch, but not an explicit retry on the same workspace owner.
      return (
        !entry.controller.signal.aborted &&
        JSON.stringify(resolve()) === JSON.stringify(route) &&
        (ref.target.kind === 'local' ||
          (ref.pairingRevision !== undefined &&
            getRuntimeEnvironmentRevision(ref.target.environmentId) === ref.pairingRevision))
      )
    },
    close() {
      pending.delete(entry)
      entry.controller.abort()
    }
  }
}
export type ConversationTabLifetime = ReturnType<typeof captureConversationTabLifetime>

/** Called only by confirmed owner teardown, not view hide/unmount. Cancels same-ID old requests. */
export function cancelConversationTabLifetimes(
  workspaces: ReadonlySet<string>,
  owns?: (workspaceId: string, host: ExecutionHostId) => boolean
) {
  for (const entry of pending) {
    if (workspaces.has(entry.workspaceId) && (!owns || owns(entry.workspaceId, entry.host))) {
      entry.controller.abort()
      pending.delete(entry)
    }
  }
}
