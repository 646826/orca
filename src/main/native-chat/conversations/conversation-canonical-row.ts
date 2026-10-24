import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'

export function conversationCanonicalRowBodies(row: JournalRow): AgentJournalItemBody[] {
  if (row.kind === 'item' || row.kind === 'submission') {
    return [row.body]
  }
  if (row.kind === 'lifecycle-batch') {
    return row.mutations.flatMap((mutation) => (mutation.kind === 'item' ? [mutation.body] : []))
  }
  return []
}
