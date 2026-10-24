import type { ConversationSegmentPage } from './conversation-history-rpc-schema'
import type { ConversationLoadedHistory } from './conversation-read-refresh'
/** The contiguous tail cursor remains independent of cached segments across a metadata gap. */
export function nextConversationHistoryPage(
  descriptors: ConversationSegmentPage['segments'],
  loaded: ReadonlyMap<string, ConversationLoadedHistory>,
  beforeOrdinal: number | null
) {
  const segment = descriptors.find(
    (entry) => !loaded.has(entry.segmentId) || loaded.get(entry.segmentId)?.page.next
  )
  if (beforeOrdinal !== null && (!segment || beforeOrdinal > segment.ordinal)) {
    return { kind: 'segment-range' as const, beforeOrdinal }
  }
  return segment
    ? { kind: 'history' as const, segment, previous: loaded.get(segment.segmentId) }
    : { kind: 'complete' as const }
}
