import { readJournalSessionEpoch } from '../agent-session-journal/journal-row-table'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type Database from '../../sqlite/sync-database'
import type { AgentSessionStoreState } from '../../runtime/agent-session-store-state'
import { settleAgentSessionOperationInto } from '../../runtime/agent-session-operation-admission'
import {
  ConversationTransferRecoveryResultSchema,
  type ConversationTransferRecoveryRequest,
  type ConversationTransferRecoveryResult
} from '../../../shared/conversation-transfer-recovery'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { appendJournalHostCompound } from '../agent-session-journal/journal-host-compound-writes'
import { conversationContextDigest } from './conversation-context-consent'
import { verifyConversationTriggerAttachmentBytes } from './conversation-trigger-attachments'
import { ConversationRefusal } from './conversation-read-model'
import { writeConversation, writeIntent } from './conversation-store-transitions'
import type { ConversationStore } from './conversation-store'
import {
  isConversationTransferRecoveryOwner,
  requireTransferRecoveryAuthority
} from './conversation-transfer-recovery-authority'

export function readTransferRecoveryReplay(
  db: Database.Database,
  request: ConversationTransferRecoveryRequest,
  callerKey: string
): ConversationTransferRecoveryResult | null {
  const row = db
    .prepare(`SELECT transfer_id,caller_key,client_operation_id,request_digest,
    CASE WHEN octet_length(result_json)<=8192 THEN result_json END result_json
    FROM conversation_transfer_recoveries WHERE transfer_id=? OR (caller_key=? AND client_operation_id=?)`)
    .get(request.transferId, callerKey, request.clientOperationId)
  if (!row) {
    return null
  }
  if (
    row.transfer_id !== request.transferId ||
    row.caller_key !== callerKey ||
    row.client_operation_id !== request.clientOperationId ||
    row.request_digest !== conversationContextDigest(request) ||
    typeof row.result_json !== 'string'
  ) {
    throw new ConversationRefusal('stale-generation')
  }
  return ConversationTransferRecoveryResultSchema.parse(JSON.parse(row.result_json))
}

export function commitConversationTransferRecovery(
  db: Database.Database,
  state: AgentSessionStoreState,
  request: ConversationTransferRecoveryRequest,
  callerKey: string,
  stateDirectory: string,
  retirement: JournalRow | undefined,
  sourceOwner: { runtimeFence: number; epoch: string }
): ConversationTransferRecoveryResult {
  if (!db.isTransaction) {
    throw new Error('Transfer recovery requires the host transaction')
  }
  const replay = readTransferRecoveryReplay(db, request, callerKey)
  if (replay) {
    return replay
  }
  const { intent, conversation, binding, proof } = requireTransferRecoveryAuthority(
    db,
    request,
    stateDirectory
  )
  if (
    !isConversationTransferRecoveryOwner(
      state.records.get(proof.targetSessionId),
      proof,
      state.records.get(proof.sourceSessionId)
    )
  ) {
    throw new ConversationRefusal('stale-generation')
  }
  if (
    state.records.get(proof.targetSessionId)?.lease.runtimeFence !== request.expectedRuntimeFence ||
    state.records.get(proof.sourceSessionId)?.lease.runtimeFence !== sourceOwner.runtimeFence ||
    readJournalSessionEpoch(db, proof.sourceSessionId) !== sourceOwner.epoch ||
    retirement?.kind !== 'tombstone' ||
    retirement.retireSubmission !== true ||
    retirement.epoch !== request.expectedTargetEpoch ||
    retirement.itemId !== agentJournalSubmissionKey(proof.targetSubmissionId)
  ) {
    throw new ConversationRefusal('stale-generation')
  }
  const operation = state.operations.get(intent.operationKey)
  if (binding.kind === 'trigger' && !operation) {
    throw new ConversationRefusal('expired-intent')
  }
  if (binding.kind === 'trigger') {
    const other = db
      .prepare(`SELECT 1 FROM conversation_trigger_reservations
      WHERE operation_key=? AND transfer_id!=? AND state NOT IN ('reserved','cancelled') LIMIT 1`)
      .get(intent.operationKey, request.transferId)
    if (other) {
      throw new ConversationRefusal('unverified-delivery')
    }
    db.prepare(
      "UPDATE conversation_trigger_reservations SET state='cancelled' WHERE operation_key=? AND (transfer_id=? OR state='reserved')"
    ).run(intent.operationKey, request.transferId)
    writeIntent(db, { ...intent, version: intent.version + 1, phase: 'cancelled' })
    if (operation) {
      settleAgentSessionOperationInto(state, {
        callerKey: operation.callerKey,
        operationId: operation.operationId,
        outcome: { status: 'failed', code: 'conversationSwitchCancelled' }
      })
    }
  } else {
    db.prepare(
      "UPDATE conversation_trigger_reservations SET state='cancelled' WHERE transfer_id=?"
    ).run(request.transferId)
  }
  writeConversation(db, {
    ...conversation,
    revision: conversation.revision + 1,
    pendingOperationKey: binding.kind === 'trigger' ? null : conversation.pendingOperationKey
  })
  const result: ConversationTransferRecoveryResult = {
    transferId: binding.transferId,
    operationKey: intent.operationKey,
    action: request.action,
    sourceSessionId: binding.queueSessionId,
    sourceMessageId: binding.messageId,
    conversationRevision: conversation.revision + 1,
    operationVersion: intent.version + (binding.kind === 'trigger' ? 1 : 0)
  }
  db.prepare('INSERT INTO conversation_transfer_recoveries VALUES(?,?,?,?,?,?,?,?,?,?)').run(
    binding.transferId,
    callerKey,
    request.clientOperationId,
    conversationContextDigest(request),
    request.expectedProofDigest,
    request.action,
    JSON.stringify(result),
    JSON.stringify(proof),
    retirement.epoch,
    retirement.seq
  )
  return result
}

export async function recoverConversationTransfer(input: {
  db: Database.Database
  stateDirectory: string
  store: ConversationStore
  request: ConversationTransferRecoveryRequest
  callerKey: string
  openJournal: (sessionId: string) => Promise<AgentSessionJournal>
  isCurrent: (journal: AgentSessionJournal) => boolean
  signal?: AbortSignal
}): Promise<ConversationTransferRecoveryResult> {
  const { db, request, callerKey } = input
  const replay = readTransferRecoveryReplay(db, request, callerKey)
  if (replay) {
    return replay
  }
  const initial = requireTransferRecoveryAuthority(db, request, input.stateDirectory)
  if (input.store.currentTransferRecoveryFence(initial.proof) !== request.expectedRuntimeFence) {
    throw new ConversationRefusal('stale-generation')
  }
  const signal = input.signal ?? new AbortController().signal
  signal.throwIfAborted()
  await verifyConversationTriggerAttachmentBytes(input.stateDirectory, db, initial.binding, signal)
  const [source, target] = await Promise.all([
    input.openJournal(initial.binding.queueSessionId),
    input.openJournal(initial.binding.targetSessionId)
  ])
  let result: ConversationTransferRecoveryResult | undefined
  await appendJournalHostCompound(
    [source, target],
    () => {
      const duplicate = readTransferRecoveryReplay(db, request, callerKey)
      if (duplicate) {
        result = duplicate
        return { appends: [] }
      }
      const { binding, original, proof } = requireTransferRecoveryAuthority(
        db,
        request,
        input.stateDirectory
      )
      if (input.store.currentTransferRecoveryFence(proof) !== request.expectedRuntimeFence) {
        throw new ConversationRefusal('stale-generation')
      }
      const sourceFence = input.store.currentTransferRecoverySourceFence(proof)
      if (sourceFence === null) {
        throw new ConversationRefusal('stale-generation')
      }
      const sourceOwner = { runtimeFence: sourceFence, epoch: source.cursor().epoch }
      const card = source.queuedMessages.get(binding.messageId)
      if (card && (card.state !== 'withdrawn' || card.fingerprint !== binding.sourceFingerprint)) {
        throw new ConversationRefusal('stale-source')
      }
      const order = original.queueOrder
      if (!order) {
        throw new ConversationRefusal('missing-source')
      }
      const restore = source.queuedMessages.plan(
        request.action === 'return-held-draft'
          ? [
              {
                messageId: binding.messageId,
                change: {
                  op: 'queued',
                  body: original.body,
                  options: original.options,
                  position: order.position,
                  queuedAt: order.queuedAt,
                  holdReason: 'send_failed'
                }
              }
            ]
          : [],
        { transferId: binding.transferId }
      )
      return {
        appends: [
          { journal: source, rows: restore.rows, receipt: restore.receipt },
          {
            journal: target,
            rows: target.planRetireSubmission(
              binding.targetSubmissionId,
              request.expectedRuntimeFence,
              {
                epoch: proof.targetEpoch,
                sequence: proof.targetSubmissionSequence,
                payloadFingerprint: proof.targetFingerprint
              }
            )
          }
        ],
        receiptRow: (prepared) => prepared.find((entry) => entry.journal === target)?.rows[0],
        receipt: input.store.transferRecoveryReceipt(request, callerKey, sourceOwner, (value) => {
          result = value
        }),
        validate: (transactionDb) => {
          if (transactionDb !== db) {
            throw new Error('Transfer recovery host database changed')
          }
          signal.throwIfAborted()
          const authority = requireTransferRecoveryAuthority(db, request, input.stateDirectory)
          if (
            input.store.currentTransferRecoveryFence(authority.proof) !==
              request.expectedRuntimeFence ||
            input.store.currentTransferRecoverySourceFence(authority.proof) !==
              sourceOwner.runtimeFence ||
            readJournalSessionEpoch(db, authority.proof.sourceSessionId) !== sourceOwner.epoch
          ) {
            throw new ConversationRefusal('stale-generation')
          }
        }
      }
    },
    { isCurrent: input.isCurrent, signal }
  )
  if (!result) {
    throw new ConversationRefusal('corrupt-record')
  }
  return result
}
