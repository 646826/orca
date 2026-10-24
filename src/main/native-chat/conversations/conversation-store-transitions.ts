import type Database from '../../sqlite/sync-database'
import { agentSessionScopeKey, type AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionAccountHomesEqual } from '../../../shared/agent-session-account-home'
import type { AgentSessionStoreState } from '../../runtime/agent-session-store-state'
import type {
  ConversationRecord,
  ConversationParticipant,
  ConversationSegment,
  ConversationSwitchIntent,
  ConversationSourceBoundary
} from '../../../shared/conversation-record'
import type { ConversationTargetIdentity } from '../../../shared/conversation-wire'
import {
  ConversationRefusal,
  readConversation,
  readSwitchIntent,
  readConversationDeliverySources
} from './conversation-read-model'

export function requireRecord(state: AgentSessionStoreState, id: string): AgentSessionRecord {
  const record = state.records.get(id)
  if (!record) {
    throw new ConversationRefusal('missing-record')
  }
  return record
}
export function requireConversation(db: Database.Database, id: string): ConversationRecord {
  const record = readConversation(db, id)
  if (!record) {
    throw new ConversationRefusal('missing-record')
  }
  return record
}
export function requireIntent(db: Database.Database, key: string): ConversationSwitchIntent {
  const intent = readSwitchIntent(db, key)
  if (!intent) {
    throw new ConversationRefusal('missing-record')
  }
  return intent
}
export function sameScope(
  left: ConversationTargetIdentity['location'],
  right: ConversationTargetIdentity['location']
): boolean {
  return (
    agentSessionScopeKey(left) === agentSessionScopeKey(right) &&
    left.workspaceKind === right.workspaceKind
  )
}
export function validateIdentity(
  expected: ConversationTargetIdentity,
  actual: AgentSessionRecord
): void {
  if (
    expected.provider !== actual.provider ||
    !sameScope(expected.location, actual.location) ||
    !agentSessionAccountHomesEqual(expected.accountHome, actual.accountHome)
  ) {
    throw new ConversationRefusal('identity-mismatch')
  }
}
export function participant(
  conversation: ConversationRecord,
  record: AgentSessionRecord,
  state: ConversationParticipant['state']
): ConversationParticipant {
  return {
    conversationId: conversation.conversationId,
    sessionId: record.sessionId,
    provider: record.provider,
    location: record.location,
    accountHome: record.accountHome,
    nativeBindingGeneration: 1,
    contextGeneration: conversation.contextGeneration,
    state
  }
}
export function assertGeneration(
  conversation: ConversationRecord,
  expected: {
    expectedRevision: number
    expectedContextGeneration: number
    expectedActivationFence: number
  }
): void {
  if (
    conversation.revision !== expected.expectedRevision ||
    conversation.contextGeneration !== expected.expectedContextGeneration ||
    conversation.activationFence !== expected.expectedActivationFence
  ) {
    throw new ConversationRefusal('stale-generation')
  }
}
export function assertIntent(
  conversation: ConversationRecord,
  intent: ConversationSwitchIntent,
  version: number
): void {
  if (
    conversation.pendingOperationKey !== intent.operationKey ||
    intent.version !== version ||
    intent.contextGeneration !== conversation.contextGeneration ||
    intent.activationFence !== conversation.activationFence + 1
  ) {
    throw new ConversationRefusal('stale-generation')
  }
}
export function assertSources(
  db: Database.Database,
  intent: ConversationSwitchIntent,
  sources: ConversationSourceBoundary[]
): void {
  const actual = readConversationDeliverySources(db, intent.conversationId, intent.targetSessionId)
  if (JSON.stringify(actual) !== JSON.stringify(sources)) {
    throw new ConversationRefusal('stale-source')
  }
}
export function allowedPhase(
  from: ConversationSwitchIntent['phase'],
  to: ConversationSwitchIntent['phase']
): boolean {
  return (
    (from === 'quiescing' && to === 'prepared') ||
    (from === 'prepared' && (to === 'prepared' || to === 'delivering')) ||
    (from === 'delivering' && (to === 'delivering' || to === 'reconciliation-required')) ||
    (from === 'reconciliation-required' && to === 'prepared')
  )
}
export function writeConversation(db: Database.Database, value: ConversationRecord): void {
  db.prepare(
    'INSERT INTO conversations(conversation_id,record_json) VALUES (?,?) ON CONFLICT(conversation_id) DO UPDATE SET record_json=excluded.record_json'
  ).run(value.conversationId, JSON.stringify(value))
}
export function writeParticipant(db: Database.Database, value: ConversationParticipant): void {
  db.prepare(
    'INSERT INTO conversation_participants(session_id,conversation_id,record_json) VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET record_json=excluded.record_json'
  ).run(value.sessionId, value.conversationId, JSON.stringify(value))
}
export function writeSegment(db: Database.Database, value: ConversationSegment): void {
  db.prepare(
    'INSERT INTO conversation_segments(segment_id,conversation_id,ordinal,record_json) VALUES (?,?,?,?) ON CONFLICT(segment_id) DO UPDATE SET record_json=excluded.record_json'
  ).run(value.segmentId, value.conversationId, value.ordinal, JSON.stringify(value))
}
export function writeIntent(db: Database.Database, value: ConversationSwitchIntent): void {
  db.prepare(
    'INSERT INTO conversation_switch_intents(operation_key,conversation_id,record_json) VALUES (?,?,?) ON CONFLICT(operation_key) DO UPDATE SET record_json=excluded.record_json'
  ).run(value.operationKey, value.conversationId, JSON.stringify(value))
}
