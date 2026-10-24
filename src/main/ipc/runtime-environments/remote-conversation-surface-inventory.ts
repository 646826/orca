import { MAX_CONVERSATION_INVENTORY_BYTES } from '../../../shared/conversation-inventory'
import { ConversationTabSurfaceSchema } from '../../../shared/conversation-surface-rpc'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import type { ConversationTabSurface } from '../../native-chat/conversations/conversation-tab-surface'

type Stream = { environmentId: string; generation: number }
type Workspace = { epoch: string; version: number; surfaces: readonly ConversationTabSurface[] }
type Entry = { stream: Stream; workspaces: Map<string, Workspace> | null }
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function workspace(value: unknown, environmentId: string): [string, Workspace] | null {
  if (
    !isRecord(value) ||
    typeof value.worktree !== 'string' ||
    typeof value.publicationEpoch !== 'string' ||
    !Number.isSafeInteger(value.snapshotVersion) ||
    typeof value.snapshotVersion !== 'number' ||
    value.snapshotVersion < 0 ||
    !isRecord(value.conversationSurfaces) ||
    value.conversationSurfaces.complete !== true ||
    Buffer.byteLength(JSON.stringify(value.conversationSurfaces)) > MAX_CONVERSATION_INVENTORY_BYTES
  ) {
    return null
  }
  const parsed = ConversationTabSurfaceSchema.array().safeParse(value.conversationSurfaces.surfaces)
  if (
    !parsed.success ||
    parsed.data.some(
      (surface) =>
        surface.location.executionHostId !== 'local' ||
        surface.location.workspaceId !== value.worktree
    )
  ) {
    return null
  }
  return [
    value.worktree,
    {
      epoch: value.publicationEpoch,
      version: value.snapshotVersion,
      surfaces: parsed.data.map((surface) => ({
        ...surface,
        location: { ...surface.location, executionHostId: toRuntimeExecutionHostId(environmentId) }
      }))
    }
  ]
}
function unique(workspaces: Map<string, Workspace>): boolean {
  const tabs = new Set<string>()
  const conversations = new Set<string>()
  for (const entry of workspaces.values()) {
    for (const surface of entry.surfaces) {
      if (tabs.has(surface.tabId) || conversations.has(surface.conversationId)) {
        return false
      }
      tabs.add(surface.tabId)
      conversations.add(surface.conversationId)
    }
  }
  return (
    Buffer.byteLength(JSON.stringify([...workspaces.values()])) <= MAX_CONVERSATION_INVENTORY_BYTES
  )
}

/** Validation evidence from a live authenticated stream; persisted display snapshots never enter. */
export function createRemoteConversationSurfaceInventory() {
  const entries = new Map<string, Entry>()
  return {
    open(environmentId: string, generation: number): Stream {
      const stream = { environmentId, generation }
      entries.set(environmentId, { stream, workspaces: null })
      return stream
    },
    close(stream: Stream): void {
      if (entries.get(stream.environmentId)?.stream === stream) {
        entries.delete(stream.environmentId)
      }
    },
    record(stream: Stream, frame: unknown, generation: number): void {
      const entry = entries.get(stream.environmentId)
      if (!entry || entry.stream !== stream || stream.generation !== generation) {
        return
      }
      if (!isRecord(frame)) {
        entry.workspaces = null
        return
      }
      if (frame.type === 'end') {
        entries.delete(stream.environmentId)
        return
      }
      if (frame.type === 'snapshots') {
        if (entry.workspaces) {
          entries.delete(stream.environmentId)
          return
        }
        if (frame.conversationSurfacesComplete !== true || !Array.isArray(frame.snapshots)) {
          entry.workspaces = null
          return
        }
        const next = new Map<string, Workspace>()
        for (const raw of frame.snapshots) {
          const decoded = workspace(raw, stream.environmentId)
          if (!decoded || next.has(decoded[0])) {
            entry.workspaces = null
            return
          }
          next.set(...decoded)
        }
        entry.workspaces = unique(next) ? next : null
      } else if (frame.type === 'updated' && entry.workspaces) {
        const decoded = workspace(frame, stream.environmentId)
        if (!decoded) {
          entry.workspaces = null
          return
        }
        const prior = entry.workspaces.get(decoded[0])
        if (prior && prior.epoch !== decoded[1].epoch) {
          entry.workspaces = null
          return
        }
        if (prior && prior.version >= decoded[1].version) {
          return
        }
        const next = new Map(entry.workspaces)
        next.set(...decoded)
        entry.workspaces = unique(next) ? next : null
      }
    },
    read(environmentId: string, generation: number): readonly ConversationTabSurface[] | null {
      const entry = entries.get(environmentId)
      return entry?.stream.generation === generation && entry.workspaces
        ? [...entry.workspaces.values()].flatMap((value) => value.surfaces)
        : null
    }
  }
}
