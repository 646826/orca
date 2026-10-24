import type { ConversationHistoricalPage } from './conversation-rpc'
import type { NativeChatMessage } from './native-chat-types'
import { projectStructuredItemToNativeChat } from './structured-agent-session-projection'

type Entry = ConversationHistoricalPage['items'][number]
export function conversationHistoryIdentity(entry: Entry): string {
  return JSON.stringify([entry.originSource.sessionId, entry.originSource.epoch, entry.item.itemId])
}
export function mergeConversationHistory(
  current: readonly Entry[],
  incoming: readonly Entry[]
): Entry[] {
  const rows = new Map(current.map((entry) => [conversationHistoryIdentity(entry), entry]))
  for (const entry of incoming) {
    const key = conversationHistoryIdentity(entry)
    const previous = rows.get(key)
    if (!previous || previous.item.revision <= entry.item.revision) {
      rows.set(key, entry)
    }
  }
  return [...rows.values()]
}

/** Historical rows never carry an action addressed to the currently active native session. */
export function projectConversationHistory(
  entries: readonly Entry[],
  segmentLabel?: (entry: Entry) => string
): NativeChatMessage[] {
  const result: NativeChatMessage[] = []
  let previousSegment: string | undefined
  for (const entry of entries) {
    const projected = projectStructuredItemToNativeChat(entry.item)
    if (!projected) {
      continue
    }
    if (segmentLabel && previousSegment !== entry.segmentId) {
      result.push({
        id: `conversation-segment:${entry.segmentId}`,
        role: 'system',
        source: 'transcript',
        timestamp: null,
        transcriptOrder: result.length,
        blocks: [{ type: 'text', text: segmentLabel(entry) }]
      })
    }
    previousSegment = entry.segmentId
    let shortened = Boolean(
      projected.shortened ||
      (entry.item.body.kind === 'tool-call' && entry.item.body.output?.truncated) ||
      (entry.item.body.kind === 'diff' && entry.item.body.patch.truncated)
    )
    const blocks = projected.blocks.map((block) => {
      if (block.type === 'tool-result') {
        const { fullOutputItemId, ...readOnly } = block
        shortened ||= fullOutputItemId !== undefined
        return readOnly
      }
      if (block.type === 'text') {
        const { orcaStop: _stop, usageLimitTurnItemId: _limit, ...readOnly } = block
        return readOnly
      }
      return block
    })
    result.push({
      ...projected,
      conversationSource: {
        sessionId: entry.originSource.sessionId,
        segmentId: entry.segmentId,
        epoch: entry.originSource.epoch,
        itemId: entry.item.itemId,
        revision: entry.item.revision
      },
      id: conversationHistoryIdentity(entry),
      blocks,
      transcriptOrder: result.length,
      transcriptOffset: result.length,
      turnId: undefined,
      parentId: undefined,
      ...(shortened ? { shortened: true } : {})
    })
  }
  return result
}
