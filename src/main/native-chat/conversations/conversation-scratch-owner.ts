import { mkdirSync, rmSync } from 'node:fs'
import { startJournalRowFold } from '../agent-session-journal/journal-open'
import type { JournalEpochPin } from '../agent-session-journal/journal-epoch-pins'
import { agentJournalItemForWire } from '../agent-session-wire/agent-session-item-wire-form'
import { boundedFrameItem } from '../agent-session-wire/agent-session-bounded-frame-item'
import { ConversationReplayScratch } from './conversation-replay-scratch'
import { ConversationHistoryIndex } from './conversation-history-index'
import type { ConversationItemPageCursor } from './conversation-reducer-disk-map'
import {
  CONVERSATION_SCRATCH_BATCH_BYTES,
  CONVERSATION_SCRATCH_BATCH_ROWS,
  type ConversationScratchReplayEntry,
  type ConversationScratchHistoryEntry
} from './conversation-scratch-protocol'

/** Private projections only: this owner never opens the canonical journal. */
export class ConversationScratchOwner {
  private replay: ConversationReplayScratch | undefined
  private fold: ReturnType<typeof startJournalRowFold> | undefined
  private history: ConversationHistoryIndex | undefined
  private readonly shortened = new Set<string>()
  private finalized = false
  private closing = false
  private replayFailed = false
  private historyFailed = false
  constructor(private readonly directory: string) {
    mkdirSync(directory, { mode: 0o700 })
  }
  openReplay(pin: JournalEpochPin): void {
    this.assertOpen()
    if (this.replay) {
      throw new Error('Presentation replay already open')
    }
    const replay = new ConversationReplayScratch(this.directory)
    this.replay = replay
    this.fold = startJournalRowFold(pin, replay.items, {
      latestContextClearSequence: replay.items.latestContextClearSequence.bind(replay.items)
    })
    this.finalized = false
    this.replayFailed = false
    this.shortened.clear()
  }
  appendReplay(entries: readonly ConversationScratchReplayEntry[]): void {
    this.assertOpen()
    const replay = this.replay,
      fold = this.fold
    if (!replay || !fold || this.finalized || this.replayFailed) {
      throw new Error('Presentation replay is not writable')
    }
    const bytes = entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.rowJson), 0)
    if (
      !entries.length ||
      entries.length > CONVERSATION_SCRATCH_BATCH_ROWS ||
      (entries.length > 1 && bytes > CONVERSATION_SCRATCH_BATCH_BYTES)
    ) {
      throw new RangeError('Presentation batch exceeds resource limit')
    }
    try {
      replay.batch(() => {
        for (const entry of entries) {
          if (!fold.add(entry)) {
            throw new Error('Presentation reduction failed')
          }
          if (entry.shortenedItem) {
            if (entry.shortenedItem.shortened) {
              this.shortened.add(entry.shortenedItem.itemId)
            } else {
              this.shortened.delete(entry.shortenedItem.itemId)
            }
          }
        }
      })
    } catch (error) {
      this.replayFailed = true
      throw error
    }
  }
  finishReplay() {
    this.assertOpen()
    if (!this.fold || this.finalized || this.replayFailed) {
      throw new Error('Presentation replay is not writable')
    }
    const loaded = this.fold.finish()
    for (const itemId of this.shortened) {
      this.shortened.add(loaded.state.aliases.get(itemId) ?? itemId)
    }
    this.finalized = !loaded.damage && !loaded.newer
    return { damage: !!loaded.damage, newer: !!loaded.newer }
  }
  replayPage(after: ConversationItemPageCursor | null, limit: number, maxBytes: number) {
    this.assertOpen()
    if (!this.replay || !this.finalized || this.replayFailed) {
      throw new Error('Presentation replay is not published')
    }
    return this.replay.items.page(
      after,
      limit,
      maxBytes,
      (item) =>
        boundedFrameItem(
          agentJournalItemForWire(
            this.shortened.has(item.itemId) ? { ...item, shortened: true } : item
          )
        ).item
    )
  }
  closeReplay(): void {
    this.finalized = false
    this.replay?.close()
    this.replay = undefined
    this.fold = undefined
    this.shortened.clear()
  }
  openHistory(): void {
    this.assertOpen()
    if (this.history) {
      throw new Error('Historical index already open')
    }
    this.history = new ConversationHistoryIndex(this.directory)
  }
  beginHistoryEpoch(): void {
    this.historyIndex().beginEpoch()
  }
  appendHistory(entries: readonly ConversationScratchHistoryEntry[]): void {
    const history = this.historyIndex()
    try {
      for (const entry of entries) {
        history.append(entry.item, entry.segmentId, entry.epoch)
      }
    } catch (error) {
      this.historyFailed = true
      throw error
    }
  }
  flushHistory(): void {
    this.historyIndex().flush()
  }
  historyPage(input: Parameters<ConversationHistoryIndex['page']>[0]) {
    return this.historyIndex().page(input)
  }
  close(): void {
    this.closing = true
    this.closeReplay()
    this.history?.close()
    this.history = undefined
    rmSync(this.directory, { recursive: true, force: true })
  }
  private historyIndex(): ConversationHistoryIndex {
    this.assertOpen()
    if (!this.history || this.historyFailed) {
      throw new Error('Historical index is not open')
    }
    return this.history
  }
  private assertOpen(): void {
    if (this.closing) {
      throw new Error('Conversation scratch owner is closing')
    }
  }
}
