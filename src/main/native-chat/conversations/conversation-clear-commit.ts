import { createHash } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import type { AgentSessionStoreState } from '../../runtime/agent-session-store-state'
import { settleAgentSessionOperationInto } from '../../runtime/agent-session-operation-admission'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import { pinJournalEpoch } from '../agent-session-journal/journal-epoch-pins'
import {
  ConversationRefusal,
  readParticipant,
  readSegments,
  readSourceBoundary
} from './conversation-read-model'
import {
  requirePendingClear,
  releasedClearParticipants,
  writeClearIntent
} from './conversation-clear-validation'
import {
  requireRecord,
  writeConversation,
  writeParticipant,
  writeSegment
} from './conversation-store-transitions'
import { registerConversationSourceSpan } from './conversation-source-attribution'

export type ConversationClearCommit = {
  operationKey: string
  expectedVersion: number
  now: number
  journalAppends: readonly {
    sessionId: string
    epoch: string
    firstSequence: number
    rowCount: number
  }[]
}

/** Called only by the journal's fatal receipt, before either store draft or rows are published. */
export function commitConversationClear(
  db: Database.Database,
  state: AgentSessionStoreState,
  request: ConversationClearCommit,
  row: JournalRow | undefined
) {
  const { intent, conversation } = requirePendingClear(
    db,
    request.operationKey,
    request.expectedVersion
  )
  if (intent.phase !== 'prepared') {
    throw new ConversationRefusal('invalid-phase')
  }
  const participants = releasedClearParticipants(db, state, intent)
  if (participants.some((p, i) => p.runtimeFence !== intent.participants[i]?.runtimeFence)) {
    throw new ConversationRefusal('stale-generation')
  }
  const segments = readSegments(db, conversation.conversationId)
  const active = segments.find((s) => s.segmentId === conversation.activeSegmentId)
  const source = intent.sourceBoundaries.find((s) => s.sessionId === active?.sessionId)
  const participant = participants.find((p) => p.sessionId === active?.sessionId)
  const operationId = createHash('sha256').update(intent.operationKey).digest('hex')
  if (
    !active ||
    !source ||
    !participant ||
    !row ||
    row.kind !== 'item' ||
    row.body.kind !== 'status' ||
    row.body.contextClear?.operationId !== operationId ||
    row.body.contextClear.afterFence !== participant.runtimeFence ||
    row.body.contextClear.clearedAt !== request.now ||
    row.epoch !== source.epoch ||
    row.seq !== source.endSequence + 1
  ) {
    throw new ConversationRefusal('stale-source')
  }
  if (
    request.journalAppends.length !== intent.sourceBoundaries.length ||
    new Set(request.journalAppends.map((entry) => entry.sessionId)).size !==
      intent.sourceBoundaries.length
  ) {
    throw new ConversationRefusal('stale-source')
  }
  for (const boundary of intent.sourceBoundaries) {
    const current = readSourceBoundary(db, boundary.sessionId)
    const append = request.journalAppends.find((entry) => entry.sessionId === boundary.sessionId)
    if (
      !append ||
      (append &&
        (append.epoch !== boundary.epoch || append.firstSequence !== boundary.endSequence + 1)) ||
      current.epoch !== boundary.epoch ||
      current.endSequence !== boundary.endSequence + append.rowCount
    ) {
      throw new ConversationRefusal('stale-source')
    }
  }
  // The second row is the queue divider emitted by the same journal write, not arbitrary late evidence.
  const queueRow = db
    .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?')
    .get(active.sessionId, row.epoch, row.seq + 1)
  if (typeof queueRow?.row_json !== 'string') {
    throw new ConversationRefusal('missing-source')
  }
  const queue: unknown = JSON.parse(queueRow.row_json)
  if (
    typeof queue !== 'object' ||
    queue === null ||
    !('kind' in queue) ||
    queue.kind !== 'tombstone' ||
    !('queueClear' in queue) ||
    typeof queue.queueClear !== 'object' ||
    queue.queueClear === null ||
    !('operationId' in queue.queueClear) ||
    queue.queueClear.operationId !== operationId
  ) {
    throw new ConversationRefusal('stale-source')
  }
  const origin = {
    conversationId: conversation.conversationId,
    segmentId: active.segmentId,
    contextGeneration: intent.contextGeneration,
    nativeBindingGeneration: participant.nativeBindingGeneration
  }
  for (const sequence of [row.seq, row.seq + 1]) {
    db.prepare('INSERT INTO conversation_clear_rows VALUES(?,?,?,?,?,?)').run(
      active.sessionId,
      row.epoch,
      sequence,
      intent.operationKey,
      JSON.stringify(origin),
      `conversation-clear:${operationId}:archive`
    )
  }
  const nextGeneration = conversation.contextGeneration + 1
  for (const p of participants) {
    const record = requireRecord(state, p.sessionId)
    const member = readParticipant(db, p.sessionId)
    if (!member) {
      throw new ConversationRefusal('corrupt-record')
    }
    state.records.set(p.sessionId, {
      ...record,
      providerHandleChain: [],
      providerContextBoundary: { operationId, afterFence: p.runtimeFence, clearedAt: request.now },
      lease: { ...record.lease, provenHandleLinkId: null },
      updatedAt: request.now
    })
    writeParticipant(db, {
      ...member,
      contextGeneration: nextGeneration,
      nativeBindingGeneration: member.nativeBindingGeneration + 1
    })
  }
  const sealed = readSourceBoundary(db, active.sessionId)
  pinJournalEpoch(db, { ownerId: `conversation-clear:${operationId}:archive`, ...sealed })
  writeSegment(db, { ...active, boundary: sealed })
  registerConversationSourceSpan(
    db,
    active,
    sealed,
    active.boundary.epoch === sealed.epoch ? active.startSequence : 1
  )
  const segmentId = `conversation-clear:${operationId}`
  writeSegment(db, {
    ...active,
    segmentId,
    ordinal: Math.max(...segments.map((s) => s.ordinal)) + 1,
    contextGeneration: nextGeneration,
    activationFence: conversation.activationFence + 1,
    nativeBindingGeneration: participant.nativeBindingGeneration + 1,
    startSequence: sealed.endSequence + 1,
    boundary: sealed,
    lifecycle: 'activated'
  })
  writeConversation(db, {
    ...conversation,
    revision: conversation.revision + 1,
    contextGeneration: nextGeneration,
    activationFence: conversation.activationFence + 1,
    activeSegmentId: segmentId,
    pendingOperationKey: null
  })
  writeClearIntent(db, { ...intent, version: intent.version + 1, phase: 'committed' })
  const operation = state.operations.get(intent.operationKey)
  if (!operation) {
    throw new ConversationRefusal('corrupt-record')
  }
  settleAgentSessionOperationInto(state, {
    callerKey: operation.callerKey,
    operationId: operation.operationId,
    outcome: { status: 'succeeded', sessionId: active.sessionId }
  })
}
