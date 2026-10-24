import { readConversationNativeIdentities } from './conversation-origin-native-identity'
import type Database from '../../sqlite/sync-database'
import type { AgentSessionStoreState } from '../../runtime/agent-session-store-state'
import type { ConversationClearIntent } from '../../../shared/conversation-clear-record'
import { conversationContextDigest } from './conversation-context-consent'
import { ConversationRefusal, readParticipant } from './conversation-read-model'
import { requireConversation, requireRecord } from './conversation-store-transitions'
import { readConversationClearIntent } from './conversation-pending-mutation'

export function requirePendingClear(db: Database.Database, operationKey: string, version: number) {
  const intent = readConversationClearIntent(db, operationKey)
  if (!intent) {
    throw new ConversationRefusal('missing-record')
  }
  const conversation = requireConversation(db, intent.conversationId)
  if (
    intent.version !== version ||
    conversation.pendingOperationKey !== operationKey ||
    conversation.contextGeneration !== intent.contextGeneration ||
    conversation.activationFence !== intent.activationFence
  ) {
    throw new ConversationRefusal('stale-generation')
  }
  return { intent, conversation }
}

export function releasedClearParticipants(
  db: Database.Database,
  state: AgentSessionStoreState,
  intent: ConversationClearIntent
) {
  const count = db
    .prepare('SELECT COUNT(*) AS count FROM conversation_participants WHERE conversation_id=?')
    .get(intent.conversationId)?.count
  if (count !== intent.participants.length) {
    throw new ConversationRefusal('stale-generation')
  }
  return intent.participants.map((captured) => {
    const record = requireRecord(state, captured.sessionId)
    const member = readParticipant(db, captured.sessionId)
    if (
      !member ||
      member.conversationId !== intent.conversationId ||
      member.contextGeneration !== intent.contextGeneration ||
      member.nativeBindingGeneration !== captured.nativeBindingGeneration ||
      captured.nativeIdentities === undefined ||
      JSON.stringify(readConversationNativeIdentities(db, captured.sessionId)) !==
        JSON.stringify(captured.nativeIdentities) ||
      conversationContextDigest({
        sessionId: record.sessionId,
        createdAt: record.createdAt,
        provider: record.provider,
        location: record.location,
        accountHome: record.accountHome
      }) !== captured.recordBirthDigest ||
      record.lease.ownerProcess !== null ||
      record.lease.claimStatus !== 'released'
    ) {
      throw new ConversationRefusal('stale-generation')
    }
    return { ...captured, runtimeFence: record.lease.runtimeFence }
  })
}

export function writeClearIntent(db: Database.Database, intent: ConversationClearIntent) {
  db.prepare('UPDATE conversation_clear_intents SET record_json=? WHERE operation_key=?').run(
    JSON.stringify(intent),
    intent.operationKey
  )
}
