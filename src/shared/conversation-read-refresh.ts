import type {
  ConversationReaderPort,
  ConversationHistoryPage,
  ConversationSegmentPage
} from './conversation-history-rpc-schema'
import type { ConversationRecord } from './conversation-record'
import {
  mergeConversationHistory,
  conversationHistoryIdentity
} from './conversation-read-projection'
export type ConversationLoadedHistory = {
  segment: ConversationSegmentPage['segments'][number]
  page: ConversationHistoryPage
  pageCount: number
}

// At most eight additional 128-item pages per changed expanded segment in one refresh.
// Exceeding this UI work budget refuses the replacement; it never truncates stored evidence.
export class ConversationHistoryRefreshLimitError extends Error {}
const EXTRA_REFRESH_PAGES = 8

/** Revalidate only metadata/pages already expanded by the user, plus the current tail. */
export async function refreshConversationHistory(input: {
  port: ConversationReaderPort
  conversation: ConversationRecord
  loaded: ReadonlyMap<string, ConversationLoadedHistory>
  signal: AbortSignal
  readPage: (
    segment: ConversationLoadedHistory['segment'],
    after: ConversationHistoryPage['next']
  ) => Promise<ConversationHistoryPage>
}) {
  const { port, conversation, loaded, signal, readPage } = input
  async function descriptorsAt(before: number | null) {
    const page = await port.segments(before, signal)
    signal.throwIfAborted()
    if (
      page.conversation.conversationId !== conversation.conversationId ||
      page.conversation.revision !== conversation.revision ||
      page.conversation.contextGeneration !== conversation.contextGeneration
    ) {
      throw new Error('Conversation changed during read')
    }
    return page
  }
  const tail = await descriptorsAt(null)
  const descriptors = new Map(tail.segments.map((segment) => [segment.segmentId, segment]))
  const nextSegment = tail.nextSegmentOrdinal
  for (const old of [...loaded.values()].sort((a, b) => b.segment.ordinal - a.segment.ordinal)) {
    if (descriptors.has(old.segment.segmentId)) {
      continue
    }
    const page = await descriptorsAt(old.segment.ordinal + 1)
    for (const descriptor of page.segments) {
      descriptors.set(descriptor.segmentId, descriptor)
    }
  }
  const ordered = [...descriptors.values()].sort((a, b) => b.ordinal - a.ordinal)
  const nextLoaded = new Map<string, ConversationLoadedHistory>()
  for (const segment of ordered) {
    const old = loaded.get(segment.segmentId)
    if (!old && segment !== ordered[0]) {
      continue
    }
    if (old?.segment.sourceRevision === segment.sourceRevision) {
      nextLoaded.set(segment.segmentId, { ...old, segment })
      continue
    }
    let page = await readPage(segment, null),
      pageCount = 1
    const boundary = old?.page.items[0]
    const reachedBoundary = () =>
      !boundary ||
      page.items.some(
        (entry) => conversationHistoryIdentity(entry) === conversationHistoryIdentity(boundary)
      )
    while (page.next && (!reachedBoundary() || pageCount < (old?.pageCount ?? 1))) {
      if (pageCount >= (old?.pageCount ?? 1) + EXTRA_REFRESH_PAGES) {
        throw new ConversationHistoryRefreshLimitError(
          'Expanded history refresh exceeds bounded work'
        )
      }
      const previous = await readPage(segment, page.next)
      page = { ...previous, items: mergeConversationHistory(previous.items, page.items) }
      pageCount++
    }
    if (!reachedBoundary()) {
      throw new ConversationHistoryRefreshLimitError('Expanded history boundary changed')
    }
    nextLoaded.set(segment.segmentId, { segment, page, pageCount })
  }
  signal.throwIfAborted()
  return { descriptors: ordered, nextSegment, loaded: nextLoaded }
}
