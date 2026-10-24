import { releaseQueuedMessageEvidence } from '../agent-session-journal/queued-message-origin'
import { pruneConversationArchivePayloads } from './conversation-archive-payloads'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { pruneConversationArchiveEpoch } from './conversation-archive-prune'
import type { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import type { AgentSessionStoreTransactions } from '../../runtime/agent-session-store-transactions'
import {
  admitAndClaimAgentSessionOperationInto,
  settleAgentSessionOperationInto,
  type AgentSessionOperationAdmission
} from '../../runtime/agent-session-operation-admission'
import { agentSessionOperationKey } from '../../../shared/agent-session-operation-ledger'
import { ConversationRefusal } from './conversation-read-model'
import { requireConversation, writeConversation } from './conversation-store-transitions'
import { releaseJournalEpochPin } from '../agent-session-journal/journal-epoch-pins'
import { CONVERSATION_ARCHIVE_OWNERS } from './conversation-archive-owners'

export type ConversationArchiveRequest = {
  conversationId: string
  expectedRevision: number
  contextGeneration: number
}
export class ConversationArchiveStore {
  constructor(
    private readonly host: JournalHostDatabase,
    private readonly transactions: AgentSessionStoreTransactions
  ) {}
  revision(conversationId: string): number {
    const revision =
      this.host.db
        .prepare(
          'SELECT archive_revision FROM conversation_archive_deletions WHERE conversation_id=? ORDER BY archive_revision DESC LIMIT 1'
        )
        .get(conversationId)?.archive_revision ?? 0
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
      throw new ConversationRefusal('corrupt-record')
    }
    return revision
  }
  status(
    conversationId: string,
    contextGeneration: number
  ): { operationKey: string; phase: 'inventory' | 'cleanup' | 'complete' } | null {
    const row = this.host.db
      .prepare(
        'SELECT operation_key,phase FROM conversation_archive_deletions WHERE conversation_id=? AND context_generation=?'
      )
      .get(conversationId, contextGeneration)
    if (!row) {
      return null
    }
    if (
      typeof row.operation_key !== 'string' ||
      (row.phase !== 'inventory' && row.phase !== 'cleanup' && row.phase !== 'complete')
    ) {
      throw new ConversationRefusal('corrupt-record')
    }
    return { operationKey: row.operation_key, phase: row.phase }
  }
  async remove(
    request: ConversationArchiveRequest,
    operation: AgentSessionOperationAdmission,
    admit: () => void
  ) {
    const operationKey = agentSessionOperationKey(operation.callerKey, operation.operationId)
    const receipt = this.transactions.receipt((state) => {
      admit()
      const decision = admitAndClaimAgentSessionOperationInto(
        state,
        operation,
        (d) => d.decision === 'admit'
      ).decision
      if (decision.decision === 'refused') {
        throw agentSessionRefusalError(decision.code, decision.details)
      }
      if (decision.decision !== 'admit') {
        if (
          !this.host.db
            .prepare(
              'SELECT 1 FROM conversation_archive_deletions WHERE operation_key=? AND conversation_id=? AND context_generation=?'
            )
            .get(operationKey, request.conversationId, request.contextGeneration)
        ) {
          throw new ConversationRefusal('expired-intent')
        }
        return
      }
      const conversation = requireConversation(this.host.db, request.conversationId)
      if (conversation.revision !== request.expectedRevision) {
        throw new ConversationRefusal('stale-generation')
      }
      if (conversation.pendingOperationKey) {
        throw new ConversationRefusal('busy')
      }
      if (
        !Number.isSafeInteger(request.contextGeneration) ||
        request.contextGeneration < 1 ||
        request.contextGeneration >= conversation.contextGeneration
      ) {
        throw new ConversationRefusal('invalid-phase')
      }
      if (
        !this.host.db
          .prepare(
            "SELECT 1 FROM conversation_segments WHERE conversation_id=? AND json_extract(record_json,'$.contextGeneration')=? LIMIT 1"
          )
          .get(request.conversationId, request.contextGeneration)
      ) {
        throw new ConversationRefusal('missing-source')
      }
      this.host.db
        .prepare(
          "INSERT INTO conversation_archive_deletions(operation_key,conversation_id,context_generation,archive_revision,phase) VALUES(?,?,?,?,'inventory')"
        )
        .run(
          operationKey,
          request.conversationId,
          request.contextGeneration,
          conversation.revision + 1
        )
      writeConversation(this.host.db, { ...conversation, revision: conversation.revision + 1 })
      settleAgentSessionOperationInto(state, {
        callerKey: operation.callerKey,
        operationId: operation.operationId,
        outcome: { status: 'succeeded', sessionId: '' }
      })
    })
    await this.transactions.commitReceipt(receipt)
    return {
      operationKey,
      conversationId: request.conversationId,
      contextGeneration: request.contextGeneration
    }
  }
  /** One bounded metadata batch per call. Shared prefix bytes may remain required by another owner. */
  async cleanup(
    request: { operationKey: string; conversationId: string },
    admit: () => void
  ): Promise<{ complete: boolean; sharedEvidenceMayRemain: true }> {
    const { operationKey } = request
    admit()
    const prior = this.host.db
      .prepare(
        'SELECT phase,conversation_id,context_generation,owner_cursor FROM conversation_archive_deletions WHERE operation_key=?'
      )
      .get(operationKey)
    const ownerPage =
      prior?.phase === 'inventory' && prior.conversation_id === request.conversationId
        ? this.host.db
            .prepare(CONVERSATION_ARCHIVE_OWNERS)
            .all(prior.conversation_id, prior.context_generation, prior.owner_cursor)
        : null
    let complete = false
    const receipt = this.transactions.receipt(() => {
      admit()
      const db = this.host.db
      const job = db
        .prepare('SELECT * FROM conversation_archive_deletions WHERE operation_key=?')
        .get(operationKey)
      if (
        !job ||
        job.conversation_id !== request.conversationId ||
        typeof job.conversation_id !== 'string' ||
        typeof job.context_generation !== 'number' ||
        typeof job.owner_cursor !== 'string'
      ) {
        throw new ConversationRefusal('missing-record')
      }
      if (job.phase === 'complete') {
        complete = true
        return
      }
      if (job.phase === 'inventory') {
        // Metadata enumeration is outside the writer queue; publish only against its exact cursor.
        if (
          !ownerPage ||
          prior?.owner_cursor !== job.owner_cursor ||
          prior.context_generation !== job.context_generation
        ) {
          return
        }
        const owners = ownerPage
        for (const owner of owners) {
          if (typeof owner.owner_id !== 'string') {
            throw new ConversationRefusal('corrupt-record')
          }
          db.prepare('INSERT OR IGNORE INTO conversation_archive_resources VALUES(?,?)').run(
            operationKey,
            owner.owner_id
          )
        }
        db.prepare(
          'UPDATE conversation_archive_deletions SET owner_cursor=?,phase=? WHERE operation_key=?'
        ).run(
          owners.at(-1)?.owner_id ?? job.owner_cursor,
          owners.length < 128 ? 'cleanup' : 'inventory',
          operationKey
        )
        return
      }
      const owner = db
        .prepare(
          'SELECT owner_id FROM conversation_archive_resources WHERE operation_key=? ORDER BY owner_id LIMIT 1'
        )
        .get(operationKey)?.owner_id
      if (owner === undefined) {
        if (!pruneConversationArchiveEpoch(db, operationKey)) {
          return
        }
        if (!pruneConversationArchivePayloads(db, operationKey)) {
          return
        }
        db.prepare(
          "UPDATE conversation_archive_deletions SET phase='complete' WHERE operation_key=?"
        ).run(operationKey)
        complete = true
        return
      }
      if (typeof owner !== 'string') {
        throw new ConversationRefusal('corrupt-record')
      }
      const pins = db
        .prepare(
          'SELECT session_id,epoch,end_sequence FROM journal_epoch_pins WHERE owner_id=? LIMIT 128'
        )
        .all(owner)
      for (const pin of pins) {
        if (
          typeof pin.session_id !== 'string' ||
          typeof pin.epoch !== 'string' ||
          typeof pin.end_sequence !== 'number'
        ) {
          throw new ConversationRefusal('corrupt-record')
        }
        db.prepare('INSERT OR IGNORE INTO conversation_archive_epochs VALUES(?,?,?)').run(
          operationKey,
          pin.session_id,
          pin.epoch
        )
        releaseJournalEpochPin(
          db,
          {
            ownerId: owner,
            sessionId: pin.session_id,
            epoch: pin.epoch,
            endSequence: pin.end_sequence
          },
          { deferRowPrune: true }
        )
      }
      if (pins.length === 128) {
        return
      }
      const claims = db
        .prepare(
          'SELECT upload_id,name FROM conversation_attachment_claims WHERE owner_id=? LIMIT 128'
        )
        .all(owner)
      for (const claim of claims) {
        db.prepare(
          'DELETE FROM conversation_attachment_claims WHERE owner_id=? AND upload_id=? AND name=?'
        ).run(owner, claim.upload_id, claim.name)
      }
      if (claims.length < 128) {
        releaseQueuedMessageEvidence(db, owner)
        db.prepare(
          'DELETE FROM conversation_archive_resources WHERE operation_key=? AND owner_id=?'
        ).run(operationKey, owner)
      }
    })
    await this.transactions.commitReceipt(receipt)
    return { complete, sharedEvidenceMayRemain: true }
  }
}
