import {
  ConversationReaderOwnerChangedError,
  type ConversationReaderPort,
  type ConversationHistoryPage,
  type ConversationSegmentPage,
  type ConversationOlderPageResult
} from './conversation-history-rpc-schema'
import { nextConversationHistoryPage } from './conversation-read-page-choice'
import {
  refreshConversationHistory,
  ConversationHistoryRefreshLimitError,
  type ConversationLoadedHistory
} from './conversation-read-refresh'
import type { ConversationSurfaceSnapshot } from './conversation-surface-rpc'
import { mergeConversationHistory } from './conversation-read-projection'

type Segment = ConversationSegmentPage['segments'][number]
type Loaded = ConversationLoadedHistory
export type ConversationReaderState = {
  surface: ConversationSurfaceSnapshot | null
  rows: ConversationHistoryPage['items']
  readCurrent: boolean
  loading: boolean
  loadingOlder: boolean
  hasMore: boolean
  generation: number
  error: boolean
  resourceLimited: boolean
}
export function createConversationReaderState(port: ConversationReaderPort) {
  const controller = new AbortController(),
    listeners = new Set<() => void>()
  let state: ConversationReaderState = {
    surface: null,
    rows: [],
    readCurrent: false,
    loading: true,
    loadingOlder: false,
    hasMore: false,
    generation: 0,
    error: false,
    resourceLimited: false
  }
  let descriptors: Segment[] = [],
    nextSegment: number | null = null
  let loaded = new Map<string, Loaded>()
  let watchRevision = 0
  let watchClose: (() => void) | undefined, reconnectClose: (() => void) | undefined
  let pending: Promise<void> | null = null,
    older: Promise<ConversationOlderPageResult> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined,
    requested = false
  const live = () => !controller.signal.aborted
  function publish(change: Partial<ConversationReaderState>) {
    if (!live()) {
      return
    }
    state = { ...state, ...change }
    listeners.forEach((listener) => listener())
  }
  function publishRows() {
    const ordered = [...loaded.values()].sort((a, b) => a.segment.ordinal - b.segment.ordinal)
    publish({
      rows: ordered.flatMap((entry) => entry.page.items),
      hasMore: nextConversationHistoryPage(descriptors, loaded, nextSegment).kind !== 'complete',
      loadingOlder: false
    })
  }
  async function readPage(segment: Segment, after: ConversationHistoryPage['next']) {
    const page = await port.history(
      segment.segmentId,
      segment.sourceRevision,
      after,
      controller.signal
    )
    controller.signal.throwIfAborted()
    if (page.status === 'resource-limit' || page.status === 'source-unavailable') {
      throw new Error('Conversation source unavailable')
    }
    return page
  }
  async function refresh() {
    if (!live()) {
      return
    }
    if (pending) {
      requested = true
      return pending
    }
    if (older) {
      requested = true
      return
    }
    pending = (async () => {
      publish({ readCurrent: false })
      try {
        const surface = await port.snapshot(controller.signal)
        controller.signal.throwIfAborted()
        const previous = state.surface
        if (
          previous &&
          (previous.conversation.contextGeneration !== surface.conversation.contextGeneration ||
            (previous.archiveRevision ?? 0) !== (surface.archiveRevision ?? 0))
        ) {
          loaded = new Map()
          descriptors = []
          nextSegment = null
          publish({ rows: [], hasMore: false, generation: state.generation + 1 })
        }
        const refreshed = await refreshConversationHistory({
          port,
          conversation: surface.conversation,
          loaded,
          signal: controller.signal,
          readPage
        })
        descriptors = refreshed.descriptors
        nextSegment = refreshed.nextSegment
        loaded = refreshed.loaded
        publish({
          surface,
          loading: false,
          error: false,
          resourceLimited: false,
          readCurrent: !requested
        })
        publishRows()
      } catch (error) {
        if (error instanceof ConversationReaderOwnerChangedError) {
          clearOwner()
        }
        publish({
          loading: false,
          error: true,
          resourceLimited: error instanceof ConversationHistoryRefreshLimitError,
          readCurrent: false
        })
      } finally {
        pending = null
        if (requested && live()) {
          requested = false
          schedule()
        }
      }
    })()
    return pending
  }
  function schedule() {
    if (!live()) {
      return
    }
    publish({ readCurrent: false })
    if (timer) {
      return
    }
    timer = setTimeout(() => {
      timer = undefined
      void refresh()
    }, 100)
  }
  function clearOwner() {
    loaded = new Map()
    descriptors = []
    nextSegment = null
    publish({
      surface: null,
      rows: [],
      readCurrent: false,
      hasMore: false,
      error: true,
      generation: state.generation + 1
    })
  }
  async function openWatch() {
    const revision = ++watchRevision
    watchClose?.()
    watchClose = undefined
    try {
      const close = await port.watch(
        schedule,
        () => publish({ error: true, readCurrent: false }),
        clearOwner
      )
      if (!live() || revision !== watchRevision) {
        close()
      } else {
        watchClose = close
      }
    } catch {
      publish({ error: true, readCurrent: false })
    }
  }
  async function loadEarlier(): Promise<ConversationOlderPageResult> {
    if (!live()) {
      return 'superseded'
    }
    if (older) {
      return older
    }
    older = (async () => {
      if (pending) {
        await pending
      }
      if (!live()) {
        return 'superseded' as const
      }
      publish({ loadingOlder: true })
      try {
        let choice = nextConversationHistoryPage(descriptors, loaded, nextSegment)
        if (choice.kind === 'segment-range') {
          const page = await port.segments(choice.beforeOrdinal, controller.signal)
          controller.signal.throwIfAborted()
          if (
            page.conversation.contextGeneration !== state.surface?.conversation.contextGeneration ||
            page.conversation.revision !== state.surface?.conversation.revision
          ) {
            publish({ loadingOlder: false, readCurrent: false })
            schedule()
            return 'superseded' as const
          }
          const merged = new Map(descriptors.map((segment) => [segment.segmentId, segment]))
          for (const segment of page.segments) {
            merged.set(segment.segmentId, segment)
          }
          descriptors = [...merged.values()].sort((a, b) => b.ordinal - a.ordinal)
          nextSegment = page.nextSegmentOrdinal
          choice = nextConversationHistoryPage(descriptors, loaded, nextSegment)
        }
        if (choice.kind === 'complete') {
          publishRows()
          return 'exhausted' as const
        }
        if (choice.kind === 'history') {
          const page = await readPage(choice.segment, choice.previous?.page.next ?? null)
          loaded.set(choice.segment.segmentId, {
            segment: choice.segment,
            pageCount: (choice.previous?.pageCount ?? 0) + 1,
            page: choice.previous
              ? { ...page, items: mergeConversationHistory(page.items, choice.previous.page.items) }
              : page
          })
        }
        publishRows()
        return 'applied' as const
      } catch {
        publish({ error: true, loadingOlder: false, readCurrent: false })
        return 'failed' as const
      } finally {
        older = null
        if (requested && live()) {
          requested = false
          schedule()
        }
      }
    })()
    return older
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async start() {
      reconnectClose = port.reconnect(() => {
        void openWatch()
        schedule()
      })
      await openWatch()
      await refresh()
    },
    refresh,
    resetHistory() {
      if (pending || older || !live()) {
        return
      }
      loaded = new Map()
      descriptors = []
      nextSegment = null
      publish({ rows: [], generation: state.generation + 1, resourceLimited: false })
      void refresh()
    },
    loadEarlier,
    close() {
      controller.abort()
      if (timer) {
        clearTimeout(timer)
      }
      watchClose?.()
      reconnectClose?.()
      listeners.clear()
    }
  }
}
