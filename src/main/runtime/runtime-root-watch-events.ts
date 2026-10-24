import type { FsChangeEvent } from '../../shared/filesystem-entry-types'
import type { WatcherProcessEvent } from '../ipc/parcel-watcher-process-protocol'
import { recordWorkspaceWatchEvents, type WorkspaceWatchOwner } from './workspace-watch-observation'

export function overflowEvent(rootPath: string): FsChangeEvent[] {
  return [{ kind: 'overflow', absolutePath: rootPath }]
}

export function mapWatcherEvents(events: readonly WatcherProcessEvent[]): FsChangeEvent[] {
  return events.map((event) => ({
    kind: event.type,
    absolutePath: event.path,
    isDirectory: event.isDirectory
  }))
}

export function emitToSubscribers(
  root: WorkspaceWatchOwner & {
    closed: boolean
    subscribers: ReadonlySet<{ onEvents(events: FsChangeEvent[]): void }>
  },
  events: FsChangeEvent[]
): void {
  if (root.closed) {
    return
  }
  if (events.length > 0) {
    recordWorkspaceWatchEvents(
      root,
      events.some((event) => event.kind === 'overflow')
    )
  }
  for (const subscriber of root.subscribers) {
    subscriber.onEvents(events)
  }
}
