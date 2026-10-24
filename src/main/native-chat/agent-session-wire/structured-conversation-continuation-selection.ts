import type Database from '../../sqlite/sync-database'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  readConversationSendableDraft,
  type ConversationQueueView
} from './structured-conversation-source-queue'

/** Preserve each source's queue order, then compare host admission time with deterministic ties. */
export function nextConversationContinuationDraft(
  db: Database.Database,
  scope: { conversationId: string; contextGeneration: number; targetSessionId: string },
  getJournal: (id: string) => ConversationQueueView | null
): ReturnType<AgentSessionJournal['queuedMessages']['evidence']> {
  let selected: ReturnType<AgentSessionJournal['queuedMessages']['evidence']> = null
  const sources = db
    .prepare(`SELECT session_id FROM conversation_participants
    WHERE conversation_id=? AND session_id!=?
    AND json_extract(record_json,'$.contextGeneration')=?
    AND json_extract(record_json,'$.state')='parked' ORDER BY session_id`)
    .iterate(scope.conversationId, scope.targetSessionId, scope.contextGeneration)
  for (const source of sources) {
    if (typeof source.session_id !== 'string') {
      throw new Error('Invalid continuation participant')
    }
    const draft = readConversationSendableDraft(
      db,
      { ...scope, sessionId: source.session_id },
      getJournal
    )
    const candidate =
      draft && getJournal(source.session_id)?.queuedMessages.evidence(draft.messageId)
    if (candidate?.admittedAt === null) {
      throw new Error('Continuation admission time is unverified')
    }
    if (
      candidate &&
      (!selected ||
        candidate.admittedAt! < selected.admittedAt! ||
        (candidate.admittedAt === selected.admittedAt &&
          candidate.sourceSessionId < selected.sourceSessionId))
    ) {
      selected = candidate
    }
  }
  return selected
}
