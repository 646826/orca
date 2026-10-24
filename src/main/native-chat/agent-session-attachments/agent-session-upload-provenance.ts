import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import type Database from '../../sqlite/sync-database'
import { isPersistedAgentSessionRecord } from '../../../shared/agent-session-record'
import { conversationContextDigest } from '../conversations/conversation-context-consent'
import { readConversation, readParticipant } from '../conversations/conversation-read-model'

export type AgentSessionUploadOwner = {
  sessionId: string
  birthDigest: string
  scopeDigest: string
  boundaryDigest: string
  conversationId: string | null
  contextGeneration: number | null
}
export type AgentSessionUploadOwnership = ReturnType<typeof createAgentSessionUploadOwnership>
const refusal = () =>
  agentSessionRefusalError('agent_session_operation_invalid', {
    reason: 'attachmentScopeUnverified'
  })

export function createAgentSessionUploadProvenanceTablesSql(): string {
  return `CREATE TABLE IF NOT EXISTS agent_session_upload_provenance (
    upload_id TEXT PRIMARY KEY, name TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length>=0),
    owner_json TEXT NOT NULL, committed INTEGER NOT NULL CHECK(committed IN(0,1)));
  CREATE TRIGGER IF NOT EXISTS agent_session_upload_provenance_immutable BEFORE UPDATE ON agent_session_upload_provenance
  WHEN NEW.upload_id!=OLD.upload_id OR NEW.name!=OLD.name OR NEW.byte_length!=OLD.byte_length
    OR NEW.owner_json!=OLD.owner_json OR NEW.committed<OLD.committed
  BEGIN SELECT RAISE(ABORT,'immutable upload ownership'); END;
  CREATE TRIGGER IF NOT EXISTS agent_session_upload_provenance_no_replace BEFORE INSERT ON agent_session_upload_provenance
  WHEN EXISTS(SELECT 1 FROM agent_session_upload_provenance WHERE upload_id=NEW.upload_id)
  BEGIN SELECT RAISE(ABORT,'upload ownership already exists'); END;`
}

function capture(db: Database.Database, sessionId: string): AgentSessionUploadOwner {
  if (typeof sessionId !== 'string' || !sessionId) {
    throw refusal()
  }
  const raw = db
    .prepare('SELECT record_json FROM agent_session_records WHERE session_id=?')
    .get(sessionId)?.record_json
  const record: unknown = typeof raw === 'string' ? JSON.parse(raw) : null
  if (!isPersistedAgentSessionRecord(record) || record.sessionId !== sessionId) {
    throw refusal()
  }
  const member = readParticipant(db, sessionId)
  const conversation = member && readConversation(db, member.conversationId)
  if (member && (!conversation || member.contextGeneration !== conversation.contextGeneration)) {
    throw refusal()
  }
  return {
    sessionId,
    birthDigest: conversationContextDigest({
      sessionId,
      createdAt: record.createdAt,
      provider: record.provider,
      location: record.location,
      accountHome: record.accountHome
    }),
    scopeDigest: conversationContextDigest(record.location),
    boundaryDigest: conversationContextDigest(record.providerContextBoundary ?? null),
    conversationId: member?.conversationId ?? null,
    contextGeneration: member?.contextGeneration ?? null
  }
}
function validateCurrent(
  db: Database.Database,
  owner: AgentSessionUploadOwner
): AgentSessionUploadOwner {
  const current = capture(db, owner.sessionId)
  if (
    current.birthDigest !== owner.birthDigest ||
    current.boundaryDigest !== owner.boundaryDigest ||
    (owner.conversationId !== null &&
      (current.conversationId !== owner.conversationId ||
        current.contextGeneration !== owner.contextGeneration)) ||
    (owner.conversationId === null &&
      current.conversationId !== null &&
      current.contextGeneration !== 1)
  ) {
    throw refusal()
  }
  return current
}
function decode(value: unknown): AgentSessionUploadOwner {
  if (typeof value !== 'string') {
    throw refusal()
  }
  const owner: unknown = JSON.parse(value)
  if (
    typeof owner !== 'object' ||
    owner === null ||
    !('sessionId' in owner) ||
    typeof owner.sessionId !== 'string' ||
    !('birthDigest' in owner) ||
    typeof owner.birthDigest !== 'string' ||
    !('scopeDigest' in owner) ||
    typeof owner.scopeDigest !== 'string' ||
    !('boundaryDigest' in owner) ||
    typeof owner.boundaryDigest !== 'string' ||
    !('conversationId' in owner) ||
    (owner.conversationId !== null && typeof owner.conversationId !== 'string') ||
    !('contextGeneration' in owner) ||
    (owner.contextGeneration !== null &&
      (typeof owner.contextGeneration !== 'number' ||
        !Number.isSafeInteger(owner.contextGeneration) ||
        owner.contextGeneration < 1)) ||
    (owner.contextGeneration === null) !== (owner.conversationId === null)
  ) {
    throw refusal()
  }
  return {
    sessionId: owner.sessionId,
    birthDigest: owner.birthDigest,
    scopeDigest: owner.scopeDigest,
    boundaryDigest: owner.boundaryDigest,
    conversationId: owner.conversationId,
    contextGeneration: owner.contextGeneration
  }
}

export function createAgentSessionUploadOwnership(database: () => Database.Database) {
  return {
    capture: (sessionId: string) => capture(database(), sessionId),
    begin(input: {
      uploadId: string
      name: string
      byteLength: number
      owner: AgentSessionUploadOwner
    }): void {
      const db = database()
      validateCurrent(db, input.owner)
      db.prepare('INSERT INTO agent_session_upload_provenance VALUES(?,?,?,?,0)').run(
        input.uploadId,
        input.name,
        input.byteLength,
        JSON.stringify(input.owner)
      )
    },
    commit(uploadId: string, owner: AgentSessionUploadOwner): void {
      const db = database()
      validateCurrent(db, owner)
      const result = db
        .prepare(
          'UPDATE agent_session_upload_provenance SET committed=1 WHERE upload_id=? AND owner_json=?'
        )
        .run(uploadId, JSON.stringify(owner))
      if (result.changes !== 1) {
        throw refusal()
      }
    }
  }
}

export function assertConversationUploadOwner(
  db: Database.Database,
  input: { uploadId: string; targetSessionId: string }
): void {
  const row = db
    .prepare('SELECT owner_json,committed FROM agent_session_upload_provenance WHERE upload_id=?')
    .get(input.uploadId)
  if (row?.committed !== 1) {
    throw refusal()
  }
  const source = validateCurrent(db, decode(row.owner_json))
  if (source.sessionId === input.targetSessionId) {
    return
  }
  const target = capture(db, input.targetSessionId)
  if (
    source.scopeDigest !== target.scopeDigest ||
    source.conversationId === null ||
    source.conversationId !== target.conversationId ||
    source.contextGeneration !== target.contextGeneration
  ) {
    throw refusal()
  }
}
