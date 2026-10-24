import { z } from 'zod'
import type Database from '../../sqlite/sync-database'
import { runJournalTransaction } from '../agent-session-journal/journal-transaction'
import { readConversation, readSwitchIntent } from './conversation-read-model'
import { conversationContextDigest } from './conversation-context-consent'

const requestSchema = z.object({
  operationKey: z.string().min(1),
  expectedApprovalRevision: z.number().int().nonnegative().default(0),
  expectedVersion: z.number().int().positive(),
  expectedContextGeneration: z.number().int().positive(),
  targetSessionId: z.string().min(1),
  targetBindingDigest: z.string().min(1),
  capabilityFingerprint: z.string().min(1),
  policy: z.enum(['full', 'budgeted', 'fresh']),
  disclosure: z.literal('available-canonical'),
  authorizedCallerKey: z.string().min(1)
})
export type ConversationPreparationRequest = Omit<
  z.input<typeof requestSchema>,
  'authorizedCallerKey'
>
export function createConversationPreparationRequestTablesSql(): string {
  return `CREATE TABLE IF NOT EXISTS conversation_preparation_requests (
    operation_key TEXT NOT NULL, revision INTEGER NOT NULL, request_json TEXT NOT NULL, PRIMARY KEY(operation_key,revision)
  );
  CREATE TABLE IF NOT EXISTS conversation_preparation_request_previews (
    manifest_id TEXT PRIMARY KEY, operation_key TEXT NOT NULL, request_digest TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS conversation_preparation_request_preview_no_update BEFORE UPDATE ON conversation_preparation_request_previews
  BEGIN SELECT RAISE(ABORT,'preparation request preview is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS conversation_preparation_request_preview_no_replace BEFORE INSERT ON conversation_preparation_request_previews
  WHEN EXISTS(SELECT 1 FROM conversation_preparation_request_previews WHERE manifest_id=NEW.manifest_id)
  BEGIN SELECT RAISE(ABORT,'preparation request preview is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS conversation_preparation_request_no_update BEFORE UPDATE ON conversation_preparation_requests
  BEGIN SELECT RAISE(ABORT,'preparation request is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS conversation_preparation_request_no_replace BEFORE INSERT ON conversation_preparation_requests
  WHEN EXISTS(SELECT 1 FROM conversation_preparation_requests WHERE operation_key=NEW.operation_key AND revision=NEW.revision)
  BEGIN SELECT RAISE(ABORT,'preparation request is immutable'); END;`
}
export function readConversationPreparationRequest(db: Database.Database, operationKey: string) {
  const row = db
    .prepare(
      'SELECT request_json FROM conversation_preparation_requests WHERE operation_key=? ORDER BY revision DESC LIMIT 1'
    )
    .get(operationKey)
  return row ? requestSchema.parse(JSON.parse(String(row.request_json))) : null
}
/** Caller identity and recipient authorization must come from host RPC authorization. */
export function approveConversationPreparationRequest(
  db: Database.Database,
  request: ConversationPreparationRequest,
  authorizedCallerKey: string
): void {
  const value = requestSchema.parse({ ...request, authorizedCallerKey })
  runJournalTransaction(db, () => {
    const intent = readSwitchIntent(db, value.operationKey)
    if (
      !intent ||
      intent.version !== value.expectedVersion ||
      intent.contextGeneration !== value.expectedContextGeneration ||
      intent.targetSessionId !== value.targetSessionId ||
      (intent.phase !== 'quiescing' && intent.phase !== 'prepared') ||
      readConversation(db, intent.conversationId)?.pendingOperationKey !== intent.operationKey
    ) {
      throw new Error('Preparation request is stale')
    }
    const existing = readConversationPreparationRequest(db, value.operationKey)
    if (existing) {
      if (conversationContextDigest(existing) === conversationContextDigest(value)) {
        return
      }
      if (value.expectedApprovalRevision !== existing.expectedApprovalRevision + 1) {
        throw new Error('Preparation request approval revision changed')
      }
    }
    if (!existing && value.expectedApprovalRevision !== 0) {
      throw new Error('Preparation approval revision missing')
    }
    db.prepare('INSERT INTO conversation_preparation_requests VALUES(?,?,?)').run(
      value.operationKey,
      value.expectedApprovalRevision + 1,
      JSON.stringify(value)
    )
  })
}
