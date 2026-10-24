import { z } from 'zod'
import { isAdmissibleAgentJournalRenderItem } from '../../../shared/agent-session-journal-schemas'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'

const renderItem = z.custom<AgentJournalRenderItem>(isAdmissibleAgentJournalRenderItem)

export const CONVERSATION_SCRATCH_BATCH_ROWS = 16
export const CONVERSATION_SCRATCH_BATCH_BYTES = 256 * 1024
export const CONVERSATION_SCRATCH_MESSAGE_BYTES = 8 * 1024 * 1024
export const CONVERSATION_SCRATCH_JOB_LIMIT = 4
const natural = z.number().int().nonnegative().safe()
const text = z.string().min(1)
export const ScratchReplayCursor = z.object({
  sequence: z.number().int(),
  index: z.number().int(),
  ordinal: natural
})
const historyCursor = z.object({
  epochOrdinal: natural,
  sequence: natural,
  index: natural,
  ordinal: natural
})
const pin = z.object({ ownerId: text, sessionId: text, epoch: text, endSequence: natural })
const replayEntry = z.object({
  seq: natural,
  ts: z.number(),
  rowJson: text,
  shortenedItem: z.object({ itemId: text, shortened: z.boolean() }).optional()
})
const historyEntry = z.object({ item: renderItem, segmentId: text, epoch: text })
export const ScratchHistoryPageInput = z.object({
  segmentId: text,
  sessionId: text,
  provider: text,
  sourceRevision: text,
  after: historyCursor.nullable(),
  direction: z.enum(['forward', 'backward']).optional(),
  limit: z.number().int().min(1).max(128),
  byteLimit: z
    .number()
    .int()
    .min(1)
    .max(4 * 1024 * 1024)
})
export const ConversationScratchCommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('open-replay'), pin }),
  z.object({
    command: z.literal('append-replay'),
    entries: z.array(replayEntry).min(1).max(CONVERSATION_SCRATCH_BATCH_ROWS)
  }),
  z.object({
    command: z.literal('replay-page'),
    after: ScratchReplayCursor.nullable(),
    limit: z.number().int().min(1).max(256),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(4 * 1024 * 1024)
  }),
  z.object({
    command: z.literal('append-history'),
    entries: z.array(historyEntry).min(1).max(128)
  }),
  z.object({ command: z.literal('history-page'), input: ScratchHistoryPageInput }),
  z.object({
    command: z.enum([
      'finish-replay',
      'close-replay',
      'open-history',
      'begin-history-epoch',
      'flush-history',
      'close'
    ])
  })
])
export type ConversationScratchCommand = z.infer<typeof ConversationScratchCommandSchema>
export type ConversationScratchReplayEntry = z.infer<typeof replayEntry>
export type ConversationScratchHistoryEntry = z.infer<typeof historyEntry>
export const ScratchReplayPage = z.object({
  items: z.array(renderItem).max(256),
  next: ScratchReplayCursor.nullable()
})
export const ScratchReplayFinished = z.object({ damage: z.boolean(), newer: z.boolean() })
export const ScratchHistoricalPage = z.object({
  segmentId: text,
  sourceRevision: text,
  readOnly: z.literal(true),
  items: z
    .array(
      z.object({
        segmentId: text,
        provider: text,
        originSource: z.object({ sessionId: text, epoch: text, sequence: natural }),
        revisionEpoch: text,
        item: renderItem
      })
    )
    .max(128),
  next: historyCursor.nullable(),
  status: z.enum(['complete', 'more', 'source-unavailable', 'resource-limit'])
})
export const ConversationScratchResponseSchema = z.discriminatedUnion('ok', [
  z.object({ id: natural, ok: z.literal(true), value: z.unknown() }),
  z.object({ id: natural, ok: z.literal(false), message: z.string(), resourceLimit: z.boolean() })
])
export function assertScratchMessageBound(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value)) > CONVERSATION_SCRATCH_MESSAGE_BYTES) {
    throw new RangeError('Conversation scratch message exceeds resource limit')
  }
}
