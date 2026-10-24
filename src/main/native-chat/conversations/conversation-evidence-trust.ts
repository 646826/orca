import { ConversationRpcRefusal } from '../../../shared/conversation-rpc-refusal'
import {
  ConversationEvidenceTrustScopeSchema as scopeSchema,
  type ConversationEvidenceTrustChoice
} from '../../../shared/conversation-evidence-trust'
export type {
  ConversationEvidenceTrustChoice,
  ConversationEvidenceTrustScope
} from '../../../shared/conversation-evidence-trust'
import type Database from '../../sqlite/sync-database'
import { readConversation, readParticipant, readSwitchIntent } from './conversation-read-model'
import { conversationContextAccountDigest } from './conversation-context-authority'
import { conversationContextDigest } from './conversation-context-consent'
import { runJournalTransaction } from '../agent-session-journal/journal-transaction'
import {
  CONVERSATION_EVIDENCE_TOOL_SCHEMA_DIGEST,
  type ConversationEvidenceTransport
} from './conversation-evidence-tool-contract'

/** Resolver must use actual selected executable/workspace/permission facts; never client launch metadata. */
export type ConversationEvidenceLaunchReader = (
  sessionId: string
) => { launchFingerprint: string; transport: ConversationEvidenceTransport } | null
export function createConversationEvidenceTrustTablesSql(): string {
  return `CREATE TABLE IF NOT EXISTS conversation_evidence_tool_trust (
 choice_digest TEXT PRIMARY KEY,operation_key TEXT NOT NULL,scope_json TEXT NOT NULL,caller_key TEXT NOT NULL,approved_at INTEGER NOT NULL
 );
 CREATE TRIGGER IF NOT EXISTS conversation_evidence_trust_no_update BEFORE UPDATE ON conversation_evidence_tool_trust
 BEGIN SELECT RAISE(ABORT,'evidence tool trust is immutable'); END;
 CREATE TRIGGER IF NOT EXISTS conversation_evidence_trust_no_replace BEFORE INSERT ON conversation_evidence_tool_trust
 WHEN EXISTS(SELECT 1 FROM conversation_evidence_tool_trust WHERE choice_digest=NEW.choice_digest)
 BEGIN SELECT RAISE(ABORT,'evidence tool trust is immutable'); END;`
}
export function readConversationEvidenceTrustChoice(
  db: Database.Database,
  operationKey: string,
  readLaunch: ConversationEvidenceLaunchReader
): ConversationEvidenceTrustChoice {
  const intent = readSwitchIntent(db, operationKey)
  const conversation = intent && readConversation(db, intent.conversationId)
  const target = intent && readParticipant(db, intent.targetSessionId)
  const launch = target && readLaunch(target.sessionId)
  if (
    !intent ||
    !conversation ||
    !target ||
    !launch ||
    !launch.launchFingerprint ||
    conversation.pendingOperationKey !== operationKey ||
    conversation.contextGeneration !== intent.contextGeneration ||
    target.conversationId !== conversation.conversationId ||
    target.contextGeneration !== intent.contextGeneration ||
    ['cancelled', 'failed', 'activated'].includes(intent.phase)
  ) {
    throw new ConversationRpcRefusal('trust-required')
  }
  const scope = scopeSchema.parse({
    operationKey,
    conversationId: conversation.conversationId,
    contextGeneration: conversation.contextGeneration,
    targetSessionId: target.sessionId,
    candidateSegmentId: intent.candidateSegmentId,
    activationFence: intent.activationFence,
    nativeBindingGeneration: target.nativeBindingGeneration,
    provider: target.provider,
    accountBindingDigest: conversationContextAccountDigest(target),
    locationDigest: conversationContextDigest(target.location),
    launchFingerprint: launch.launchFingerprint,
    transport: launch.transport,
    toolSchemaDigest: CONVERSATION_EVIDENCE_TOOL_SCHEMA_DIGEST
  })
  return { choiceDigest: conversationContextDigest(scope), scope }
}
export function approveConversationEvidenceTrust(
  db: Database.Database,
  input: { operationKey: string; choiceDigest: string; callerKey: string; now: number },
  readLaunch: ConversationEvidenceLaunchReader
): void {
  if (!input.callerKey || !Number.isSafeInteger(input.now)) {
    throw new Error('Evidence tool approval identity unavailable')
  }
  const approve = () => {
    const choice = readConversationEvidenceTrustChoice(db, input.operationKey, readLaunch)
    if (choice.choiceDigest !== input.choiceDigest) {
      throw new ConversationRpcRefusal('stale-preview')
    }
    if (isConversationEvidenceTrustApproved(db, choice)) {
      return
    }
    db.prepare('INSERT INTO conversation_evidence_tool_trust VALUES(?,?,?,?,?)').run(
      choice.choiceDigest,
      input.operationKey,
      JSON.stringify(choice.scope),
      input.callerKey,
      input.now
    )
  }
  if (db.isTransaction) {
    approve()
  } else {
    runJournalTransaction(db, approve)
  }
}
export function isConversationEvidenceTrustApproved(
  db: Database.Database,
  choice: ConversationEvidenceTrustChoice
): boolean {
  const checked = scopeSchema.safeParse(choice.scope)
  if (
    !checked.success ||
    conversationContextDigest(checked.data) !== choice.choiceDigest ||
    checked.data.toolSchemaDigest !== CONVERSATION_EVIDENCE_TOOL_SCHEMA_DIGEST
  ) {
    return false
  }
  const scope = checked.data
  const row = db
    .prepare(
      'SELECT operation_key,scope_json FROM conversation_evidence_tool_trust WHERE choice_digest=?'
    )
    .get(choice.choiceDigest)
  if (row?.operation_key !== scope.operationKey || typeof row.scope_json !== 'string') {
    return false
  }
  let stored: unknown
  try {
    stored = JSON.parse(row.scope_json)
  } catch {
    return false
  }
  if (conversationContextDigest(stored) !== choice.choiceDigest) {
    return false
  }
  const conversation = readConversation(db, scope.conversationId),
    target = readParticipant(db, scope.targetSessionId),
    intent = readSwitchIntent(db, scope.operationKey)
  return (
    !!conversation &&
    !!target &&
    !!intent &&
    !['cancelled', 'failed'].includes(intent.phase) &&
    intent.targetSessionId === target.sessionId &&
    intent.conversationId === scope.conversationId &&
    intent.contextGeneration === scope.contextGeneration &&
    intent.candidateSegmentId === scope.candidateSegmentId &&
    intent.activationFence === scope.activationFence &&
    target.nativeBindingGeneration === scope.nativeBindingGeneration &&
    conversation.contextGeneration === scope.contextGeneration &&
    target.contextGeneration === scope.contextGeneration &&
    target.conversationId === scope.conversationId &&
    target.provider === scope.provider &&
    conversationContextAccountDigest(target) === scope.accountBindingDigest &&
    conversationContextDigest(target.location) === scope.locationDigest
  )
}
