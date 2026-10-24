import { readConversationNativeIdentities } from './conversation-origin-native-identity'
import { commitConversationClear, type ConversationClearCommit } from './conversation-clear-commit'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import { createHash } from 'node:crypto'
import {
  requirePendingClear,
  releasedClearParticipants,
  writeClearIntent
} from './conversation-clear-validation'
import type { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import type { AgentSessionStoreTransactions } from '../../runtime/agent-session-store-transactions'
import {
  admitAndClaimAgentSessionOperationInto,
  settleAgentSessionOperationInto,
  type AgentSessionOperationAdmission
} from '../../runtime/agent-session-operation-admission'
import { agentSessionOperationKey } from '../../../shared/agent-session-operation-ledger'
import type { ConversationClearIntent } from '../../../shared/conversation-clear-record'
import { conversationContextDigest } from './conversation-context-consent'
import {
  ConversationRefusal,
  readParticipant,
  readSegments,
  readSourceBoundary
} from './conversation-read-model'
import {
  requireConversation,
  requireRecord,
  assertGeneration,
  writeConversation
} from './conversation-store-transitions'
import { readConversationClearIntent } from './conversation-pending-mutation'

export type ConversationClearRequest = {
  conversationId: string
  expectedRevision: number
  expectedContextGeneration: number
  expectedActivationFence: number
}
export class ConversationClearStore {
  constructor(
    private readonly host: JournalHostDatabase,
    private readonly transactions: AgentSessionStoreTransactions
  ) {}
  intent(key: string) {
    return readConversationClearIntent(this.host.db, key)
  }
  async reconcile(request: {
    operationKey: string
    expectedVersion: number
  }): Promise<ConversationClearIntent> {
    return this.changePhase(request, 'reconciliation-required')
  }
  async cancel(request: {
    operationKey: string
    expectedVersion: number
  }): Promise<ConversationClearIntent> {
    return this.changePhase(request, 'cancelled')
  }
  private async changePhase(
    request: { operationKey: string; expectedVersion: number },
    phase: 'cancelled' | 'reconciliation-required'
  ): Promise<ConversationClearIntent> {
    let result: ConversationClearIntent | undefined
    const receipt = this.transactions.receipt((state) => {
      const { intent, conversation } = requirePendingClear(
        this.host.db,
        request.operationKey,
        request.expectedVersion
      )
      if (intent.phase === 'committed' || intent.phase === 'cancelled') {
        throw new ConversationRefusal('invalid-phase')
      }
      if (
        this.host.db
          .prepare('SELECT 1 FROM conversation_clear_rows WHERE operation_key=? LIMIT 1')
          .get(intent.operationKey)
      ) {
        throw new ConversationRefusal('invalid-phase')
      }
      result = { ...intent, version: intent.version + 1, phase }
      writeClearIntent(this.host.db, result)
      if (phase === 'cancelled') {
        writeConversation(this.host.db, {
          ...conversation,
          revision: conversation.revision + 1,
          pendingOperationKey: null
        })
        const operation = state.operations.get(intent.operationKey)
        if (!operation) {
          throw new ConversationRefusal('expired-intent')
        }
        settleAgentSessionOperationInto(state, {
          callerKey: operation.callerKey,
          operationId: operation.operationId,
          outcome: { status: 'failed', code: 'conversationClearCancelled' }
        })
      }
    })
    await this.transactions.commitReceipt(receipt)
    if (!result) {
      throw new ConversationRefusal('corrupt-record')
    }
    return result
  }
  receipt(request: ConversationClearCommit, validate: () => void = () => {}) {
    let row: JournalRow | undefined
    const receipt = this.transactions.receipt((state) => {
      validate()
      commitConversationClear(this.host.db, state, request, row)
    })
    return {
      write: (db: typeof this.host.db, actual?: JournalRow) => {
        if (db !== this.host.db) {
          throw new Error('Conversation clear crossed host databases')
        }
        row = actual
        receipt.write(db, actual)
      },
      committed: receipt.committed,
      rolledBack: () => {
        row = undefined
        receipt.rolledBack?.()
      }
    }
  }
  async prepare(
    request: {
      operationKey: string
      expectedVersion: number
    },
    validate: () => void = () => {}
  ): Promise<ConversationClearIntent> {
    let prepared: ConversationClearIntent | undefined
    const receipt = this.transactions.receipt((state) => {
      validate()
      const { intent } = requirePendingClear(
        this.host.db,
        request.operationKey,
        request.expectedVersion
      )
      if (intent.phase !== 'quiescing' && intent.phase !== 'reconciliation-required') {
        throw new ConversationRefusal('invalid-phase')
      }
      const participants = releasedClearParticipants(this.host.db, state, intent)
      prepared = {
        ...intent,
        version: intent.version + 1,
        phase: 'prepared',
        participants,
        sourceBoundaries: participants.map((p) => readSourceBoundary(this.host.db, p.sessionId))
      }
      writeClearIntent(this.host.db, prepared)
    })
    await this.transactions.commitReceipt(receipt)
    if (!prepared) {
      throw new ConversationRefusal('corrupt-record')
    }
    return prepared
  }
  boundary(operationKey: string, now: number) {
    const intent = this.intent(operationKey)
    if (!intent || intent.phase !== 'prepared') {
      throw new ConversationRefusal('invalid-phase')
    }
    const conversation = requireConversation(this.host.db, intent.conversationId)
    const active = readSegments(this.host.db, intent.conversationId).find(
      (s) => s.segmentId === conversation.activeSegmentId
    )
    const member = intent.participants.find((p) => p.sessionId === active?.sessionId)
    if (!member) {
      throw new ConversationRefusal('corrupt-record')
    }
    return {
      operationId: createHash('sha256').update(operationKey).digest('hex'),
      afterFence: member.runtimeFence,
      clearedAt: now
    }
  }
  async begin(
    request: ConversationClearRequest,
    operation: AgentSessionOperationAdmission
  ): Promise<{
    decision: ReturnType<typeof admitAndClaimAgentSessionOperationInto>['decision'] | null
    intent: ConversationClearIntent | null
  }> {
    const key = agentSessionOperationKey(operation.callerKey, operation.operationId)
    let result: ConversationClearIntent | null = null
    let decision: ReturnType<typeof admitAndClaimAgentSessionOperationInto>['decision'] | null =
      null
    const receipt = this.transactions.receipt((state) => {
      const admission = admitAndClaimAgentSessionOperationInto(
        state,
        operation,
        (d) => d.decision === 'admit'
      )
      decision = admission.decision
      if (admission.decision.decision !== 'admit') {
        result = this.intent(key)
        return
      }
      const db = this.host.db
      const conversation = requireConversation(db, request.conversationId)
      assertGeneration(conversation, request)
      if (conversation.pendingOperationKey) {
        throw new ConversationRefusal('busy')
      }
      const members = db
        .prepare(
          'SELECT session_id FROM conversation_participants WHERE conversation_id=? ORDER BY session_id'
        )
        .all(conversation.conversationId)
      const participants = members.map((row) => {
        if (typeof row.session_id !== 'string') {
          throw new ConversationRefusal('corrupt-record')
        }
        const record = requireRecord(state, row.session_id)
        const member = readParticipant(db, row.session_id)
        if (!member || member.contextGeneration !== conversation.contextGeneration) {
          throw new ConversationRefusal('stale-generation')
        }
        return {
          sessionId: row.session_id,
          nativeBindingGeneration: member.nativeBindingGeneration,
          nativeIdentities: readConversationNativeIdentities(db, row.session_id),
          runtimeFence: record.lease.runtimeFence,
          recordBirthDigest: conversationContextDigest({
            sessionId: record.sessionId,
            createdAt: record.createdAt,
            provider: record.provider,
            location: record.location,
            accountHome: record.accountHome
          })
        }
      })
      if (!participants.length) {
        throw new ConversationRefusal('corrupt-record')
      }
      result = {
        operationKey: key,
        conversationId: conversation.conversationId,
        version: 1,
        contextGeneration: conversation.contextGeneration,
        activationFence: conversation.activationFence,
        phase: 'quiescing',
        preserveArchive: true,
        participants,
        sourceBoundaries: participants.map((p) => readSourceBoundary(db, p.sessionId))
      }
      db.prepare('INSERT INTO conversation_clear_intents VALUES (?,?,?)').run(
        key,
        conversation.conversationId,
        JSON.stringify(result)
      )
      writeConversation(db, {
        ...conversation,
        revision: conversation.revision + 1,
        pendingOperationKey: key
      })
    })
    await this.transactions.commitReceipt(receipt)
    return { decision, intent: result }
  }
}
