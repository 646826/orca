import type Database from '../../sqlite/sync-database'
import {
  isAgentSessionExecutionLocation,
  type AgentSessionExecutionLocation
} from '../../../shared/agent-session-record'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { ConversationRefusal } from './conversation-read-model'

export type ConversationTabSurface = {
  conversationId: string
  sourceSessionId: string
  tabId: string
  location: AgentSessionExecutionLocation
  visible: boolean
  surfaceRevision: number
  publishedRevision: number
}
export type ConversationTabScope = {
  executionHostId: ExecutionHostId
  workspaceId?: string
  includeHidden?: boolean
}
function decode(row: Record<string, unknown> | undefined): ConversationTabSurface | null {
  if (!row) {
    return null
  }
  const {
    conversation_id,
    source_session_id,
    tab_id,
    location_json,
    visible,
    surface_revision,
    published_revision
  } = row
  if (
    typeof conversation_id !== 'string' ||
    typeof source_session_id !== 'string' ||
    typeof tab_id !== 'string' ||
    typeof location_json !== 'string' ||
    (visible !== 0 && visible !== 1) ||
    typeof surface_revision !== 'number' ||
    !Number.isSafeInteger(surface_revision) ||
    surface_revision < 1 ||
    typeof published_revision !== 'number' ||
    !Number.isSafeInteger(published_revision) ||
    published_revision < 0 ||
    published_revision > surface_revision
  ) {
    throw new ConversationRefusal('corrupt-record')
  }
  let location: unknown
  try {
    location = JSON.parse(location_json)
  } catch {
    throw new ConversationRefusal('corrupt-record')
  }
  if (
    !isAgentSessionExecutionLocation(location) ||
    location.executionHostId !== row.execution_host_id ||
    location.workspaceId !== row.workspace_id
  ) {
    throw new ConversationRefusal('corrupt-record')
  }
  return {
    conversationId: conversation_id,
    sourceSessionId: source_session_id,
    tabId: tab_id,
    location,
    visible: visible === 1,
    surfaceRevision: surface_revision,
    publishedRevision: published_revision
  }
}
export function readConversationTabSurface(
  db: Database.Database,
  conversationId: string
): ConversationTabSurface | null {
  return decode(
    db.prepare('SELECT * FROM conversation_tabs WHERE conversation_id=?').get(conversationId)
  )
}
export function readConversationTabBinding(
  db: Database.Database,
  tabId: string
): ConversationTabSurface | null {
  return decode(db.prepare('SELECT * FROM conversation_tabs WHERE tab_id=?').get(tabId))
}
export function listConversationTabSurfaces(
  db: Database.Database,
  scope: ConversationTabScope
): readonly ConversationTabSurface[] {
  return db
    .prepare(`SELECT * FROM conversation_tabs WHERE execution_host_id=? AND (? IS NULL OR workspace_id=?)
    AND (?=1 OR visible=1) ORDER BY tab_id`)
    .all(
      scope.executionHostId,
      scope.workspaceId ?? null,
      scope.workspaceId ?? null,
      scope.includeHidden ? 1 : 0
    )
    .map((row) => {
      const surface = decode(row)
      if (!surface) {
        throw new ConversationRefusal('corrupt-record')
      }
      return surface
    })
}
