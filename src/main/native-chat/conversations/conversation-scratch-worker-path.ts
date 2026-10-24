import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-thread-entry-path'

export function resolveConversationScratchWorkerPath(moduleDir = __dirname): string {
  const entry = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(moduleDir),
    'conversation-scratch-worker-entry.js'
  )
  return (
    [entry, join(dirname(entry), '..', 'conversation-scratch-worker-entry.js')].find(existsSync) ??
    entry
  )
}
