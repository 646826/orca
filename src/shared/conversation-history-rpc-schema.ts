import { z } from 'zod'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { isAdmissibleAgentJournalRenderItem } from './agent-session-journal-schemas'
import {
  isConversationRecord,
  isConversationSegment,
  type ConversationRecord,
  type ConversationSegment
} from './conversation-record'
import type { ConversationSurfaceSnapshot } from './conversation-surface-rpc'
export const conversationHistoryCursorSchema = z.object({
  epochOrdinal: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  index: z.number().int().nonnegative(),
  ordinal: z.number().int().nonnegative()
})
export const conversationHistoryPageSchema = z.object({
  sourceRevision: z.string(),
  segmentId: z.string(),
  readOnly: z.literal(true),
  items: z
    .array(
      z.object({
        segmentId: z.string(),
        provider: z.string(),
        originSource: z.object({
          sessionId: z.string(),
          epoch: z.string(),
          sequence: z.number().int().positive()
        }),
        revisionEpoch: z.string(),
        item: z.custom<AgentJournalRenderItem>(isAdmissibleAgentJournalRenderItem)
      })
    )
    .max(128),
  next: conversationHistoryCursorSchema.nullable(),
  status: z.enum(['complete', 'more', 'resource-limit', 'source-unavailable'])
})
export const conversationSegmentPageSchema = z.object({
  conversation: z.custom<ConversationRecord>(isConversationRecord),
  segments: z
    .array(
      z
        .custom<ConversationSegment>(isConversationSegment)
        .and(z.object({ sourceRevision: z.string() }))
    )
    .max(128),
  nextSegmentOrdinal: z.number().int().positive().nullable()
})
export type ConversationSegmentPage = z.infer<typeof conversationSegmentPageSchema>
export type ConversationHistoryPage = z.infer<typeof conversationHistoryPageSchema>

export type ConversationHistoryCursor = z.infer<typeof conversationHistoryCursorSchema>
export type ConversationReaderPort = {
  snapshot(signal: AbortSignal): Promise<ConversationSurfaceSnapshot>
  segments(beforeOrdinal: number | null, signal: AbortSignal): Promise<ConversationSegmentPage>
  history(
    segmentId: string,
    expectedSourceRevision: string,
    after: ConversationHistoryCursor | null,
    signal: AbortSignal
  ): Promise<ConversationHistoryPage>
  watch(
    onChange: () => void,
    onUnavailable: () => void,
    onOwnerChanged?: () => void
  ): Promise<() => void>
  reconnect(callback: () => void): () => void
}
export type ConversationOlderPageResult = 'applied' | 'exhausted' | 'failed' | 'superseded'
export class ConversationReaderOwnerChangedError extends Error {
  constructor() {
    super('Conversation owner changed')
  }
}
