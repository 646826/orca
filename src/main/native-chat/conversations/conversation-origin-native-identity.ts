import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionProviderHandle } from '../../../shared/agent-session-provider-handle'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import { createHash } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { isReadableAgentSessionStoreRecord } from '../../runtime/agent-session-store-row-rules'
import { decodePersistedAgentSessionRecord } from '../../../shared/agent-session-record-stored-form'

/** Runtime fences and process identities may change; the native conversation/account may not. */
export function readConversationNativeRecord(db: Database.Database, sessionId: string) {
  const row = db
    .prepare('SELECT record_json FROM agent_session_records WHERE session_id=?')
    .get(sessionId)
  if (!row) {
    return null
  }
  const value: unknown = JSON.parse(String(row.record_json))
  if (!isReadableAgentSessionStoreRecord(sessionId, value)) {
    throw new Error('unreadable conversation native identity')
  }
  return decodePersistedAgentSessionRecord(value).record
}

export function readConversationNativeBinding(db: Database.Database, sessionId: string) {
  const record = readConversationNativeRecord(db, sessionId)
  if (!record) {
    return null
  }
  const handle = agentSessionProviderHandleChainHead(record.providerHandleChain)?.handle
  if (!handle) {
    return null
  }
  const digest = nativeIdentity(record, handle)
  return { digest, handle }
}

export function readConversationNativeIdentity(
  db: Database.Database,
  sessionId: string
): string | null {
  return readConversationNativeBinding(db, sessionId)?.digest ?? null
}

function nativeIdentity(record: AgentSessionRecord, handle: AgentSessionProviderHandle): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        provider: record.provider,
        accountHome: record.accountHome,
        location: record.location,
        handle: { transport: handle.transport, agent: handle.agent, nativeId: handle.nativeId }
      })
    )
    .digest('hex')
}

export function readConversationNativeIdentities(
  db: Database.Database,
  sessionId: string
): string[] {
  const record = readConversationNativeRecord(db, sessionId)
  if (!record) {
    throw new Error('missing conversation native record')
  }
  return [...new Set(record.providerHandleChain.map((link) => nativeIdentity(record, link.handle)))]
}
