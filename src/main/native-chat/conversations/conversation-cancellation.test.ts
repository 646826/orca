import { canDispatchConversationTransfer } from './conversation-trigger-reservation'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { foundAgentSessionRecord } from '../../runtime/agent-session-record-founding'
import { seedTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import {
  readJournalRowsAfter,
  insertJournalRow,
  publishJournalSessionEpoch
} from '../agent-session-journal/journal-row-table'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'

let root: string
let records: AgentSessionRecordStore
const now = 1_800_000_000_000
const identity = (sessionId: string, provider = 'codex') => ({
  sessionId,
  provider,
  location: {
    executionHostId: 'local' as const,
    wslDistro: null,
    workspaceId: 'folder',
    workspaceKind: 'folder' as const
  },
  accountHome: { variable: 'AGENT_HOME', path: `/accounts/${provider}` }
})
const operation = (suffix: string) => ({
  callerKey: 'caller',
  operationId: `${now}-${suffix.padStart(32, '0')}`,
  fingerprint: suffix,
  now
})
function append(sessionId: string, seq: number): void {
  insertJournalRow(openTestJournalHostDatabase(root).db, sessionId, {
    kind: 'epoch',
    reason: 'session_created',
    providerHandle: { kind: 'codex', threadId: sessionId },
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: `epoch-${sessionId}`,
    seq,
    fence: 1,
    ts: seq
  })
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-conversation-store-'))
  await seedTestAgentSessionRecordStore(root, {
    records: ['session-a', 'session-b', 'session-c'].map((id) =>
      foundAgentSessionRecord(identity(id), { claimKeyId: id, now })
    )
  })
  const host = openTestJournalHostDatabase(root)
  records = AgentSessionRecordStore.open({ journalDatabase: host, hostId: 'local' })
  for (const id of ['session-a', 'session-b', 'session-c']) {
    append(id, 1)
    publishJournalSessionEpoch(
      openTestJournalHostDatabase(root).db,
      { sessionId: id, workspaceId: 'folder' },
      `epoch-${id}`
    )
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  closeTestJournalHostDatabases()
  rmSync(root, { recursive: true, force: true })
})
async function prepareSwitch(target = 'session-b', suffix = 'b') {
  const conversation = await records.conversations.ensureSingleton('session-a')
  const admission = await records.conversations.beginSwitch(
    {
      conversationId: conversation.conversationId,
      expectedRevision: conversation.revision,
      expectedContextGeneration: conversation.contextGeneration,
      expectedActivationFence: conversation.activationFence,
      target: identity(target),
      expectedNativeBindingGeneration: 1
    },
    operation(suffix)
  )
  if (!admission.intent) {
    throw new Error('missing intent')
  }
  const prepared = await records.conversations.progress({
    operationKey: admission.intent.operationKey,
    expectedVersion: 1,
    phase: 'prepared',
    sourceBoundaries: admission.intent.sourceBoundaries,
    manifestId: 'manifest',
    deliveryReceiptId: null
  })
  return { conversation, prepared }
}
it('cancels prepared switching under generation CAS and fences an already captured dispatch', async () => {
  const { prepared } = await prepareSwitch()
  const conversation = records.conversations.read(prepared.conversationId)!
  const request = {
    operationKey: prepared.operationKey,
    expectedVersion: prepared.version,
    expectedRevision: conversation.revision,
    expectedContextGeneration: conversation.contextGeneration,
    expectedActivationFence: conversation.activationFence
  }
  await expect(records.conversations.cancel({ ...request, expectedVersion: 1 })).rejects.toThrow(
    'stale-generation'
  )
  const cancelled = await records.conversations.cancel(request)
  expect(cancelled.phase).toBe('cancelled')
  expect(records.conversations.read(prepared.conversationId)?.pendingOperationKey).toBeNull()
  expect(records.conversations.route('session-a')?.role).toBe('active')
  await expect(
    records.conversations.progress({
      operationKey: prepared.operationKey,
      expectedVersion: prepared.version,
      phase: 'delivering',
      sourceBoundaries: prepared.sourceBoundaries,
      manifestId: prepared.manifestId,
      deliveryReceiptId: null
    })
  ).rejects.toThrow('stale-generation')
})

it('records reconciliation instead of cancelling after the durable dispatch claim', async () => {
  const { prepared } = await prepareSwitch()
  const delivering = await records.conversations.progress({
    operationKey: prepared.operationKey,
    expectedVersion: prepared.version,
    phase: 'delivering',
    sourceBoundaries: prepared.sourceBoundaries,
    manifestId: prepared.manifestId,
    deliveryReceiptId: null
  })
  const conversation = records.conversations.read(prepared.conversationId)!
  const result = await records.conversations.cancel({
    operationKey: prepared.operationKey,
    expectedVersion: delivering.version,
    expectedRevision: conversation.revision,
    expectedContextGeneration: conversation.contextGeneration,
    expectedActivationFence: conversation.activationFence
  })
  expect(result.phase).toBe('reconciliation-required')
  expect(records.conversations.read(prepared.conversationId)?.pendingOperationKey).toBe(
    prepared.operationKey
  )
})

it.each(['reserved', 'appended', 'uncertain'] as const)(
  'preserves trigger identity and treats %s cancellation safely',
  async (state) => {
    const { prepared } = await prepareSwitch()
    const db = openTestJournalHostDatabase(root).db
    const sourceJournal = new AgentSessionJournal({
      database: openTestJournalHostDatabase(root),
      identity: {
        sessionId: 'session-a',
        workspaceId: 'folder',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { transport: 'codex-app-server', agent: 'codex', nativeId: 'session-a' }
      }
    })
    await sourceJournal.open()
    const card = await sourceJournal.queuedMessages.insert({
      messageId: 'queued',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'retained intent' }] }
    })
    db.prepare('INSERT INTO conversation_trigger_reservations VALUES(?,?,?,?,?,?,?,?,?)').run(
      'transfer',
      'trigger',
      prepared.operationKey,
      'session-a',
      'queued',
      'session-b',
      'candidate-send',
      JSON.stringify({
        transferId: 'transfer',
        kind: 'trigger',
        operationKey: prepared.operationKey,
        conversationId: prepared.conversationId,
        contextGeneration: 1,
        candidateGeneration: 2,
        candidateSegmentId: prepared.candidateSegmentId,
        nativeBindingGeneration: 1,
        queueSessionId: 'session-a',
        messageId: 'queued',
        sourceFingerprint: card.fingerprint,
        expectedQueueState: 'waiting',
        targetSessionId: 'session-b',
        targetSubmissionId: 'candidate-send',
        targetFingerprint: 'envelope',
        deliveryPlanId: 'plan',
        manifestId: 'manifest',
        manifestDigest: 'digest',
        targetOptionsDigest: 'options',
        attachmentClaimsDigest: 'claims'
      }),
      state
    )
    const conversation = records.conversations.read(prepared.conversationId)!
    const result = await records.conversations.cancel({
      operationKey: prepared.operationKey,
      expectedVersion: prepared.version,
      expectedRevision: conversation.revision,
      expectedContextGeneration: 1,
      expectedActivationFence: 1
    })
    expect(sourceJournal.queuedMessages.get('queued')?.body.blocks).toEqual([
      { type: 'text', text: 'retained intent' }
    ])
    const row = db
      .prepare('SELECT * FROM conversation_trigger_reservations WHERE transfer_id=?')
      .get('transfer')!
    expect(row.target_submission_id).toBe('candidate-send')
    expect(row.state).toBe(state === 'reserved' ? 'cancelled' : state)
    const withdraw = () => sourceJournal.queuedMessages.withdraw(['queued'])
    if (state === 'reserved') {
      expect(result.phase).toBe('cancelled')
      const readPreparationEvidence = vi.fn(() => null)
      const verifyTriggerClaims = vi.fn(() => false)
      expect(
        canDispatchConversationTransfer(
          db,
          {
            transferId: 'transfer',
            targetSessionId: 'session-b',
            targetSubmissionId: 'candidate-send'
          },
          {
            readPreparationEvidence,
            verifyTriggerClaims,
            readSourceCard: (id, messageId) =>
              id === 'session-a' ? sourceJournal.queuedMessages.get(messageId) : null
          }
        )
      ).toBe(false)
      expect(readPreparationEvidence).not.toHaveBeenCalled()
      expect(verifyTriggerClaims).not.toHaveBeenCalled()
      expect(await withdraw()).toHaveLength(1)
    } else {
      expect(result.phase).toBe('reconciliation-required')
      await expect(withdraw()).rejects.toThrow('reserved')
    }
  }
)

it('cancels quiescing without waiting for source revisions to settle', async () => {
  const initial = await records.conversations.ensureSingleton('session-a')
  const { intent } = await records.conversations.beginSwitch(
    {
      conversationId: initial.conversationId,
      expectedRevision: initial.revision,
      expectedContextGeneration: 1,
      expectedActivationFence: 1,
      target: identity('session-b'),
      expectedNativeBindingGeneration: 1
    },
    operation('d')
  )
  if (!intent) {
    throw new Error('missing intent')
  }
  append('session-a', 2)
  const current = records.conversations.read(initial.conversationId)!
  const result = await records.conversations.cancel({
    operationKey: intent.operationKey,
    expectedVersion: intent.version,
    expectedRevision: current.revision,
    expectedContextGeneration: 1,
    expectedActivationFence: 1
  })
  expect(result.phase).toBe('cancelled')
  expect(
    readJournalRowsAfter(openTestJournalHostDatabase(root).db, 'session-a', 'epoch-session-a', 0)
  ).toHaveLength(2)
})

it.each([true, false])(
  'serializes cancellation against dispatch CAS (cancel first=%s)',
  async (cancelFirst) => {
    const { prepared } = await prepareSwitch()
    const conversation = records.conversations.read(prepared.conversationId)!
    const cancel = () =>
      records.conversations.cancel({
        operationKey: prepared.operationKey,
        expectedVersion: prepared.version,
        expectedRevision: conversation.revision,
        expectedContextGeneration: 1,
        expectedActivationFence: 1
      })
    const dispatch = () =>
      records.conversations.progress({
        operationKey: prepared.operationKey,
        expectedVersion: prepared.version,
        phase: 'delivering',
        sourceBoundaries: prepared.sourceBoundaries,
        manifestId: prepared.manifestId,
        deliveryReceiptId: null
      })
    const [winner, loser] = await Promise.allSettled(
      cancelFirst ? [cancel(), dispatch()] : [dispatch(), cancel()]
    )
    expect(winner.status).toBe('fulfilled')
    expect(loser.status).toBe('rejected')
    expect(records.conversations.intent(prepared.operationKey)?.phase).toBe(
      cancelFirst ? 'cancelled' : 'delivering'
    )
  }
)
