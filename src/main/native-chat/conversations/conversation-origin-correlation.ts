import { createLegacyProviderTimelineIdentityScheme } from '../agent-session-timeline/provider-timeline-identity'
import type Database from '../../sqlite/sync-database'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import {
  bindConversationOrigin,
  parseConversationOrigin,
  readConversationOrigin
} from './conversation-origin'
import { readConversation, readParticipant } from './conversation-read-model'
import {
  readConversationNativeIdentity,
  readConversationNativeBinding
} from './conversation-origin-native-identity'

/** Causal provenance only. A native turn/start response does not prove send acceptance. */
export type ConversationOriginCorrelation = {
  state: 'origin-correlated'
  sessionId: string
  clientMessageId: string
  fence: number
  turnIdentity: AgentJournalItemIdentity
}
export function recordConversationOriginCorrelation(
  db: Database.Database,
  input: ConversationOriginCorrelation
): void {
  if (!db.isTransaction || !Number.isSafeInteger(input.fence) || input.fence < 1) {
    throw new Error('invalid conversation correlation transaction')
  }
  const member = readParticipant(db, input.sessionId)
  if (!member) {
    return
  }
  const turnKey = agentJournalItemKey(input.turnIdentity)
  const captured = db
    .prepare(
      'SELECT origin_json,native_identity FROM conversation_origin_acquisitions WHERE session_id=? AND fence=?'
    )
    .get(input.sessionId, input.fence)
  db.prepare('INSERT OR IGNORE INTO conversation_origin_correlations VALUES(?,?,?,?,?,0)').run(
    input.sessionId,
    input.fence,
    input.clientMessageId,
    turnKey,
    captured?.origin_json ?? null
  )
  const persisted = db
    .prepare(
      'SELECT scope_json FROM conversation_origin_correlations WHERE session_id=? AND fence=? AND submission_id=? AND turn_key=?'
    )
    .get(input.sessionId, input.fence, input.clientMessageId, turnKey)
  if (!persisted?.scope_json || persisted.scope_json !== captured?.origin_json) {
    return
  }
  if (
    !captured ||
    typeof captured.native_identity !== 'string' ||
    captured.native_identity !== readConversationNativeIdentity(db, input.sessionId)
  ) {
    return
  }
  const scope = parseConversationOrigin(JSON.parse(String(captured.origin_json)))
  const conversation = readConversation(db, member.conversationId)
  if (
    scope.conversationId !== member.conversationId ||
    scope.contextGeneration !== member.contextGeneration ||
    scope.contextGeneration !== conversation?.contextGeneration ||
    scope.nativeBindingGeneration !== member.nativeBindingGeneration
  ) {
    return
  }
  // Claude's canonical lifecycle key uses the native session, proven against the captured
  // acquisition digest above. Other adapters use the local journal session namespace.
  const native = readConversationNativeBinding(db, input.sessionId)
  const lifecycleSessionId =
    member.provider === 'claude' && native?.handle.transport === 'claude-sdk'
      ? native.handle.nativeId
      : input.sessionId
  // These are Orca's existing provider-specific lifecycle keys, never a caller-selected namespace.
  if (
    input.turnIdentity.provider !== 'legacy' ||
    input.turnIdentity.agent !== member.provider ||
    input.turnIdentity.sessionId !== lifecycleSessionId ||
    !input.turnIdentity.recordId.startsWith('turn-lifecycle:')
  ) {
    return
  }
  if (native?.handle.transport === 'acp') {
    const expected = createLegacyProviderTimelineIdentityScheme({
      agent: native.handle.agent,
      sessionId: input.sessionId
    }).turn({
      namespace: native.handle.nativeId,
      key: { source: 'provider', value: `prompt:${input.clientMessageId}` }
    })
    if (agentJournalItemKey(expected) !== turnKey) {
      return
    }
  }
  const origin = readConversationOrigin(
    db,
    input.sessionId,
    { kind: 'submission', id: input.clientMessageId },
    scope.nativeBindingGeneration
  )
  if (
    !origin ||
    origin.conversationId !== scope.conversationId ||
    origin.contextGeneration !== scope.contextGeneration
  ) {
    return
  }
  const keys = [
    { kind: 'turn' as const, id: turnKey },
    { kind: 'item' as const, id: turnKey }
  ]
  for (const key of keys) {
    const prior = readConversationOrigin(db, input.sessionId, key, scope.nativeBindingGeneration)
    if (prior && JSON.stringify(prior) !== JSON.stringify(origin)) {
      return
    }
  }
  for (const key of keys) {
    bindConversationOrigin(db, { sessionId: input.sessionId, key, origin })
  }
  db.prepare(
    'UPDATE conversation_origin_correlations SET resolved=1 WHERE resolved=0 AND session_id=? AND fence=? AND submission_id=? AND turn_key=?'
  ).run(input.sessionId, input.fence, input.clientMessageId, turnKey)
}

/** Pending exact facts can be retried after durable submission binding; never mints acceptance. */
export function resolveConversationOriginCorrelations(
  db: Database.Database,
  sessionId: string,
  limit = 128
): number {
  if (!db.isTransaction || !Number.isSafeInteger(limit) || limit < 1 || limit > 128) {
    throw new Error('invalid correlation resolution limit')
  }
  const rows = db
    .prepare(`SELECT r.* FROM conversation_origin_correlations r
    WHERE r.session_id=? AND r.resolved=0 AND r.scope_json IS NOT NULL
    AND EXISTS (SELECT 1 FROM conversation_origin_bindings b WHERE b.session_id=r.session_id
      AND b.native_binding_generation=json_extract(r.scope_json,'$.nativeBindingGeneration')
      AND b.key_kind='submission' AND b.key_id=r.submission_id) LIMIT ?`)
    .all(sessionId, limit)
  let count = 0
  for (const row of rows) {
    const identity = parseAgentJournalItemKey(String(row.turn_key))
    if (!identity) {
      throw new Error('corrupt correlation identity')
    }
    recordConversationOriginCorrelation(db, {
      state: 'origin-correlated',
      sessionId,
      fence: Number(row.fence),
      clientMessageId: String(row.submission_id),
      turnIdentity: identity
    })
    if (
      db
        .prepare(
          'SELECT resolved FROM conversation_origin_correlations WHERE session_id=? AND fence=? AND submission_id=? AND turn_key=?'
        )
        .get(sessionId, Number(row.fence), String(row.submission_id), String(row.turn_key))
        ?.resolved === 1
    ) {
      count++
    }
  }
  return count
}
