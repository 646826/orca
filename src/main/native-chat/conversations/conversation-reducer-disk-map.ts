import { isAgentSessionContextClear } from '../../../shared/agent-session-context-clear'
import {
  DEFAULT_CONVERSATION_PAGE_BYTES,
  assertConversationPageBytes,
  ConversationReplayResourceLimit
} from './conversation-replay-resource-limit'
import { projectJournalStopNote } from '../agent-session-journal/journal-stop-note-projection'
import type Database from '../../sqlite/sync-database'
import { isAdmissibleAgentJournalRenderItem } from '../../../shared/agent-session-journal-schemas'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'

export type ConversationItemPageCursor = { sequence: number; index: number; ordinal: number }

/** Scoped replay only: do not clone/expose this Map as JournalLoad; native Map storage stays empty. */
export class ConversationReducerDiskItems extends Map<string, AgentJournalRenderItem> {
  constructor(private readonly db: Database.Database) {
    super()
    db.exec(`CREATE TABLE conversation_reducer_items (
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
      item_key TEXT NOT NULL UNIQUE,
      value_json TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      sequence_index INTEGER NOT NULL,
      context_clear_sequence INTEGER
    ); CREATE INDEX conversation_reducer_item_position ON conversation_reducer_items(sequence,sequence_index,ordinal);
      CREATE INDEX conversation_reducer_context_clear ON conversation_reducer_items(context_clear_sequence)`)
  }

  override get size(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM conversation_reducer_items').get()
    if (typeof row?.count !== 'number') {
      throw new Error('Unreadable temporary reducer count')
    }
    return row.count
  }

  override set(key: string, value: AgentJournalRenderItem): this {
    this.db
      .prepare(`INSERT INTO conversation_reducer_items(item_key,value_json,sequence,sequence_index,context_clear_sequence) VALUES (?,?,?,?,?)
      ON CONFLICT(item_key) DO UPDATE SET value_json=excluded.value_json,sequence=excluded.sequence,sequence_index=excluded.sequence_index,context_clear_sequence=excluded.context_clear_sequence`)
      .run(
        key,
        JSON.stringify(value),
        value.sequence,
        value.sequenceIndex ?? 0,
        isAgentSessionContextClear(value.body) ? value.sequence : null
      )
    return this
  }

  latestContextClearSequence(): number {
    const value = this.db
      .prepare('SELECT MAX(context_clear_sequence) value FROM conversation_reducer_items')
      .get()?.value
    if (value === null) {
      return 0
    }
    if (typeof value !== 'number') {
      throw new Error('Unreadable replay context boundary')
    }
    return Math.max(0, value)
  }

  page(
    after: ConversationItemPageCursor | null,
    limit: number,
    maxTextBytes = DEFAULT_CONVERSATION_PAGE_BYTES,
    presentation?: (item: AgentJournalRenderItem) => AgentJournalRenderItem
  ): {
    items: AgentJournalRenderItem[]
    next: ConversationItemPageCursor | null
  } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new RangeError('Reducer page limit must be between 1 and 256')
    }
    assertConversationPageBytes(maxTextBytes)
    const cursor = after ?? { sequence: -1, index: -1, ordinal: 0 }
    const rows = this.db
      .prepare(`SELECT ordinal,sequence,sequence_index,octet_length(value_json) byte_length FROM conversation_reducer_items
      WHERE (sequence,sequence_index,ordinal) > (?,?,?) ORDER BY sequence,sequence_index,ordinal LIMIT ?`)
      .all(cursor.sequence, cursor.index, cursor.ordinal, limit)
    const items: AgentJournalRenderItem[] = []
    let bytes = 0
    let next: ConversationItemPageCursor | null = null
    for (const row of rows) {
      if (
        typeof row.sequence !== 'number' ||
        typeof row.sequence_index !== 'number' ||
        typeof row.ordinal !== 'number' ||
        typeof row.byte_length !== 'number'
      ) {
        throw new Error('Unreadable temporary reducer position')
      }
      if (!presentation && bytes + row.byte_length > maxTextBytes) {
        if (items.length === 0) {
          throw new ConversationReplayResourceLimit(row.byte_length)
        }
        break
      }
      const value = this.db
        .prepare('SELECT value_json FROM conversation_reducer_items WHERE ordinal=?')
        .get(row.ordinal)?.value_json
      const canonical = projectJournalStopNote(decodeItem(value), this)
      const item = presentation ? presentation(canonical) : canonical
      const itemBytes = presentation ? Buffer.byteLength(JSON.stringify(item)) : row.byte_length
      if (bytes + itemBytes > maxTextBytes) {
        if (!items.length) {
          throw new ConversationReplayResourceLimit(itemBytes)
        }
        break
      }
      items.push(item)
      bytes += itemBytes
      next = { sequence: row.sequence, index: row.sequence_index, ordinal: row.ordinal }
    }
    return { items, next }
  }

  override get(key: string): AgentJournalRenderItem | undefined {
    const row = this.db
      .prepare('SELECT value_json FROM conversation_reducer_items WHERE item_key=?')
      .get(key)
    return row ? decodeItem(row.value_json) : undefined
  }

  override has(key: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM conversation_reducer_items WHERE item_key=?').get(key) !==
      undefined
    )
  }

  override delete(key: string): boolean {
    return (
      Number(
        this.db.prepare('DELETE FROM conversation_reducer_items WHERE item_key=?').run(key).changes
      ) > 0
    )
  }

  override clear(): void {
    this.db.exec('DELETE FROM conversation_reducer_items')
  }

  override *entries(): MapIterator<[string, AgentJournalRenderItem]> {
    let ordinal = 0
    while (true) {
      const row = this.db
        .prepare(`SELECT ordinal,item_key,value_json FROM conversation_reducer_items
        WHERE ordinal>? ORDER BY ordinal LIMIT 1`)
        .get(ordinal)
      if (!row) {
        return
      }
      if (typeof row.ordinal !== 'number' || typeof row.item_key !== 'string') {
        throw new Error('Unreadable temporary reducer entry')
      }
      ordinal = row.ordinal
      yield [row.item_key, decodeItem(row.value_json)]
    }
  }

  override *keys(): MapIterator<string> {
    let ordinal = 0
    while (true) {
      const row = this.db
        .prepare(`SELECT ordinal,item_key FROM conversation_reducer_items
        WHERE ordinal>? ORDER BY ordinal LIMIT 1`)
        .get(ordinal)
      if (!row) {
        return
      }
      if (typeof row.ordinal !== 'number' || typeof row.item_key !== 'string') {
        throw new Error('Unreadable temporary reducer key')
      }
      ordinal = row.ordinal
      yield row.item_key
    }
  }

  override *values(): MapIterator<AgentJournalRenderItem> {
    for (const [, value] of this.entries()) {
      yield value
    }
  }

  override [Symbol.iterator](): MapIterator<[string, AgentJournalRenderItem]> {
    return this.entries()
  }

  override forEach(
    callbackfn: (
      value: AgentJournalRenderItem,
      key: string,
      map: Map<string, AgentJournalRenderItem>
    ) => void,
    thisArg?: unknown
  ): void {
    for (const [key, value] of this.entries()) {
      callbackfn.call(thisArg, value, key, this)
    }
  }
}

function decodeItem(raw: unknown): AgentJournalRenderItem {
  if (typeof raw !== 'string') {
    throw new Error('Unreadable temporary reducer value')
  }
  const value: unknown = JSON.parse(raw)
  if (!isAdmissibleAgentJournalRenderItem(value)) {
    throw new Error('Invalid temporary reducer item')
  }
  return value
}
