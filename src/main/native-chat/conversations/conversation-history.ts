import { ConversationRpcRefusal } from '../../../shared/conversation-rpc-refusal'
import type Database from '../../sqlite/sync-database'
import type {
  ConversationHistoricalPage,
  ConversationHistoryCursor
} from '../../../shared/conversation-rpc'
import {
  readSegments,
  readParticipant,
  readConversationSegment,
  readConversation,
  readSourceBoundary
} from './conversation-read-model'
import { readConversationSourceSpans } from './conversation-source-attribution'
import { readConversationSessionProvenance } from './conversation-source-provenance-revision'
import { conversationContextDigest } from './conversation-context-consent'
import { buildConversationPresentationPages } from './conversation-presentation-pages'
import { conversationHistoricalItemSegment } from './conversation-history-origin'
import { conversationHistoryEpochs } from './conversation-history-epochs'
import { ConversationScratchClient } from './conversation-scratch-client'
import type { ConversationScratchHistoryEntry } from './conversation-scratch-protocol'
import { ConversationReplayResourceLimit } from './conversation-replay-resource-limit'

const PAGE_BYTES = 512 * 1024
const REPLAY_BYTES = 256 * 1024 * 1024
export function conversationHistoryRevision(
  db: Database.Database,
  conversationId: string,
  segmentId: string
): string {
  const segment = readConversationSegment(db, conversationId, segmentId)
  if (
    !segment ||
    db
      .prepare(
        'SELECT 1 FROM conversation_archive_deletions WHERE conversation_id=? AND context_generation=?'
      )
      .get(conversationId, segment.contextGeneration)
  ) {
    throw new ConversationRpcRefusal('source-unavailable')
  }
  const spans = readConversationSourceSpans(db, segmentId)
  return conversationContextDigest({
    segment,
    spans,
    provenance: readConversationSessionProvenance(db, conversationId, segment.sessionId)
  })
}
export async function readConversationHistoricalPage(input: {
  db: Database.Database
  scratchDirectory: string
  conversationId: string
  segmentId: string
  expectedSourceRevision: string
  after: ConversationHistoryCursor | null
  direction?: 'forward' | 'backward'
  limit: number
  signal: AbortSignal
}): Promise<ConversationHistoricalPage> {
  const { db } = input
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 128) {
    throw new RangeError('Historical page limit')
  }
  const segment = readSegments(db, input.conversationId).find(
    (s) => s.segmentId === input.segmentId
  )
  const spans = readConversationSourceSpans(db, input.segmentId)
  const participant = segment && readParticipant(db, segment.sessionId)
  if (!segment || !participant) {
    throw new ConversationRpcRefusal('source-unavailable')
  }
  const check = () => {
    input.signal.throwIfAborted()
    ConversationScratchClient.assertAdmission(input.scratchDirectory)
    if (
      conversationHistoryRevision(db, input.conversationId, input.segmentId) !==
      input.expectedSourceRevision
    ) {
      throw new ConversationRpcRefusal('stale-source')
    }
  }
  check()
  const result: ConversationHistoricalPage = {
    sourceRevision: input.expectedSourceRevision,
    segmentId: input.segmentId,
    readOnly: true,
    items: [],
    next: input.after,
    status: 'complete'
  }
  if (!spans.length) {
    const conversation = readConversation(db, input.conversationId)
    const current = readSourceBoundary(db, segment.sessionId)
    if (
      conversation?.activeSegmentId === segment.segmentId &&
      conversation.contextGeneration === segment.contextGeneration &&
      participant.nativeBindingGeneration === segment.nativeBindingGeneration &&
      segment.startSequence === segment.boundary.endSequence + 1 &&
      current.epoch === segment.boundary.epoch &&
      current.endSequence === segment.boundary.endSequence
    ) {
      return { ...result, next: null }
    }
    throw new ConversationRpcRefusal('source-unavailable')
  }
  const epochs = conversationHistoryEpochs(db, segment)
  if (!epochs?.length) {
    return { ...result, status: 'source-unavailable' }
  }
  const origins = new Map(readSegments(db, input.conversationId).map((s) => [s.segmentId, s]))
  let index: ConversationScratchClient | undefined
  try {
    await ConversationScratchClient.retryPending(input.scratchDirectory)
    check()
    index = new ConversationScratchClient(input.scratchDirectory)
    await index.ready
    check()
    await index.openHistory()
    check()
    for (const epoch of epochs) {
      check()
      const replay = await buildConversationPresentationPages({
        db,
        pin: {
          ownerId: `history:${input.segmentId}`,
          sessionId: segment.sessionId,
          epoch: epoch.epoch,
          endSequence: epoch.endSequence
        },
        scratchDirectory: input.scratchDirectory,
        maxCanonicalBytes: REPLAY_BYTES,
        signal: input.signal,
        scratch: index,
        assertCurrent: check
      })
      if (replay.kind !== 'built') {
        check()
        return {
          ...result,
          status: replay.reason === 'resource-limit' ? 'resource-limit' : 'source-unavailable'
        }
      }
      try {
        await index.beginHistoryEpoch()
        check()
        let cursor: Parameters<typeof replay.lease.itemPage>[0] = null
        for (;;) {
          check()
          const page = await replay.lease.itemPage(cursor, 128, PAGE_BYTES)
          check()
          if (!page.items.length) {
            break
          }
          const entries: ConversationScratchHistoryEntry[] = []
          for (const item of page.items) {
            const owner = conversationHistoricalItemSegment(
              db,
              segment.sessionId,
              epoch.epoch,
              item
            )
            if (!owner) {
              return { ...result, status: 'source-unavailable' }
            }
            const original = origins.get(owner)
            if (!original) {
              return { ...result, status: 'source-unavailable' }
            }
            if (
              original.contextGeneration === segment.contextGeneration &&
              original.nativeBindingGeneration === segment.nativeBindingGeneration
            ) {
              entries.push({ item, segmentId: owner, epoch: epoch.epoch })
            }
          }
          if (entries.length) {
            await index.appendHistory(entries)
            check()
          }
          await index.flushHistory()
          check()
          cursor = page.next
          if (!cursor) {
            break
          }
        }
      } finally {
        await replay.lease.close()
      }
    }
    await index.flushHistory()
    check()
    const page = await index.historyPage({
      segmentId: input.segmentId,
      sessionId: segment.sessionId,
      provider: participant.provider,
      sourceRevision: input.expectedSourceRevision,
      after: input.after,
      direction: input.direction,
      limit: input.limit,
      byteLimit: PAGE_BYTES
    })
    check()
    return page
  } catch (error) {
    if (!(error instanceof ConversationReplayResourceLimit)) {
      throw error
    }
    return { ...result, status: 'resource-limit' }
  } finally {
    await index?.close()
    check()
  }
}
