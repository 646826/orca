import type {
  JournalRow,
  JournalLifecycleMutation
} from '../agent-session-journal/journal-row-schema'
import type { ConversationOriginKey } from './conversation-origin'

export function itemKeys(
  row: Extract<JournalRow, { kind: 'item' | 'tombstone' }> | JournalLifecycleMutation
): ConversationOriginKey[] {
  const keys: ConversationOriginKey[] = [{ kind: 'item', id: row.itemId }]
  if ('turnScope' in row && row.turnScope?.kind === 'turn') {
    keys.push({ kind: 'turn', id: row.turnScope.turnItemId })
  }
  return keys
}
export function rowKeys(row: JournalRow): ConversationOriginKey[] {
  if (row.kind === 'item' || row.kind === 'tombstone') {
    return itemKeys(row)
  }
  if (row.kind === 'queue') {
    return [{ kind: 'event', id: `queue:${row.messageId}` }]
  }
  if (row.kind === 'submission' || row.kind === 'dispatch') {
    return [{ kind: 'submission', id: row.clientMessageId }]
  }
  return [
    {
      kind: 'event',
      id:
        row.kind === 'lifecycle-batch'
          ? `settlement:${row.settlementId}`
          : `event:${row.epoch}:${row.seq}`
    }
  ]
}
