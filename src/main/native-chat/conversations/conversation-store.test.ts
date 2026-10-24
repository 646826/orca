import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  isConversationDeliveryEvidence,
  type ConversationActivationRequest
} from '../../../shared/conversation-wire'
import type { ConversationSwitchIntent } from '../../../shared/conversation-record'
import { readParticipantSourceBoundaries } from './conversation-read-model'
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
  deleteJournalEpochRows,
  readJournalRowsAfter,
  insertJournalRow,
  publishJournalSessionEpoch
} from '../agent-session-journal/journal-row-table'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'

let root: string
let records: AgentSessionRecordStore
let commitDelivery: () => void
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
  commitDelivery = () => undefined
  root = mkdtempSync(join(tmpdir(), 'orca-conversation-store-'))
  await seedTestAgentSessionRecordStore(root, {
    records: ['session-a', 'session-b', 'session-c'].map((id) =>
      foundAgentSessionRecord(identity(id), { claimKeyId: id, now })
    )
  })
  const host = openTestJournalHostDatabase(root)
  host.db.exec('CREATE TABLE test_verified_delivery (id TEXT PRIMARY KEY, evidence TEXT NOT NULL)')
  records = AgentSessionRecordStore.open({
    journalDatabase: host,
    hostId: 'local',
    conversationDeliveryCommit: () => commitDelivery(),
    conversationDeliveryEvidence: (db, id) => {
      const row = db.prepare('SELECT evidence FROM test_verified_delivery WHERE id=?').get(id)
      if (typeof row?.evidence !== 'string') {
        return null
      }
      const value: unknown = JSON.parse(row.evidence)
      return isConversationDeliveryEvidence(value) ? value : null
    }
  })
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
it('lazily binds a session once under concurrent requests without changing its native record', async () => {
  const before = records.getRecord('session-a')
  const [a, b] = await Promise.all([
    records.conversations.ensureSingleton('session-a'),
    records.conversations.ensureSingleton('session-a')
  ])
  expect(a).toEqual(b)
  expect(a.contextGeneration).toBe(1)
  expect(a.activationFence).toBe(1)
  expect(records.getRecord('session-a')).toEqual(before)
  expect(records.conversations.segments(a.conversationId)).toHaveLength(1)
})
it('atomically admits one switch, replays its operation and rejects fingerprint reuse', async () => {
  const conversation = await records.conversations.ensureSingleton('session-a')
  const request = {
    conversationId: conversation.conversationId,
    expectedRevision: conversation.revision,
    expectedContextGeneration: 1,
    expectedActivationFence: 1,
    target: identity('session-b'),
    expectedNativeBindingGeneration: 1
  }
  const admitted = await records.conversations.beginSwitch(request, operation('a'))
  expect(admitted.decision.decision).toBe('admit')
  const replay = await records.conversations.beginSwitch(request, operation('a'))
  expect(replay.decision.decision).toBe('replay')
  const conflict = await records.conversations.beginSwitch(request, {
    ...operation('a'),
    fingerprint: 'different'
  })
  expect(conflict.decision.decision).toBe('refused')
  expect(records.conversations.read(conversation.conversationId)?.activeSegmentId).toBe(
    conversation.activeSegmentId
  )
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
it('separates expected candidate delivery writes from source-context revision checks', async () => {
  const { prepared } = await prepareSwitch()
  expect(prepared.sourceBoundaries.map((b) => b.sessionId)).toEqual(['session-a'])
  append('session-b', 2)
  const delivering = await records.conversations.progress({
    operationKey: prepared.operationKey,
    expectedVersion: prepared.version,
    phase: 'delivering',
    sourceBoundaries: prepared.sourceBoundaries,
    candidateBoundary: { sessionId: 'session-b', epoch: 'epoch-session-b', endSequence: 2 },
    manifestId: 'manifest',
    deliveryReceiptId: 'receipt'
  })
  expect(delivering.candidateBoundary.endSequence).toBe(2)
  verifyDelivery(delivering)
  expect((await records.conversations.activate(activation(delivering))).activationFence).toBe(2)
})
it('retains and orders multiple epochs and attributes late evidence to its original segment', async () => {
  const conversation = await records.conversations.ensureSingleton('session-a')
  const db = openTestJournalHostDatabase(root)
  let previousEpoch = 'epoch-session-a'
  for (const epoch of ['next-epoch', 'third-epoch']) {
    db.transaction((connection) => {
      deleteJournalEpochRows(connection, 'session-a', previousEpoch)
      insertJournalRow(connection, 'session-a', {
        kind: 'epoch',
        reason: 'session_created',
        providerHandle: { kind: 'codex', threadId: 'session-a' },
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch,
        seq: 1,
        fence: 1,
        ts: 1
      })
      records.conversations
        .sourceAttributionReceipt(
          conversation.activeSegmentId,
          'session-a',
          conversation.contextGeneration
        )
        .write(connection, {
          kind: 'epoch',
          reason: 'session_created',
          providerHandle: { kind: 'codex', threadId: 'session-a' },
          v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
          epoch,
          seq: 1,
          fence: 1,
          ts: 1
        })
      publishJournalSessionEpoch(
        connection,
        { sessionId: 'session-a', workspaceId: 'folder' },
        epoch
      )
    })
    previousEpoch = epoch
  }
  for (const epoch of ['epoch-session-a', 'next-epoch', 'third-epoch']) {
    expect(readJournalRowsAfter(db.db, 'session-a', epoch, 0)).toHaveLength(1)
  }
  expect(
    records.conversations.sourceSpans(conversation.activeSegmentId).map((span) => span.epoch)
  ).toEqual(['epoch-session-a', 'next-epoch', 'third-epoch'])
})

async function ready(target = 'session-b', suffix = 'b') {
  const { prepared } = await prepareSwitch(target, suffix)
  const intent = await records.conversations.progress({
    operationKey: prepared.operationKey,
    expectedVersion: prepared.version,
    phase: 'delivering',
    sourceBoundaries: prepared.sourceBoundaries,
    manifestId: 'manifest',
    deliveryReceiptId: `receipt-${suffix}`
  })
  verifyDelivery(intent)
  return activation(intent)
}
function verifyDelivery(intent: ConversationSwitchIntent): void {
  const db = openTestJournalHostDatabase(root).db
  db.prepare('INSERT OR REPLACE INTO test_verified_delivery(id,evidence) VALUES(?,?)').run(
    intent.deliveryReceiptId,
    JSON.stringify({
      deliveryReceiptId: intent.deliveryReceiptId,
      operationKey: intent.operationKey,
      manifestId: intent.manifestId,
      targetSessionId: intent.targetSessionId,
      contextGeneration: intent.contextGeneration,
      activationFence: intent.activationFence,
      nativeBindingGeneration: intent.nativeBindingGeneration,
      sourceBoundaries: intent.sourceBoundaries,
      candidateBaseline: intent.candidateBaseline,
      candidateBoundary: intent.candidateBoundary,
      candidateReadback: readParticipantSourceBoundaries(db, intent.targetSessionId)
    })
  )
}
function activation(intent: ConversationSwitchIntent): ConversationActivationRequest {
  const conversation = records.conversations.read(intent.conversationId)
  if (!conversation || !intent.deliveryReceiptId) {
    throw new Error('missing activation fixture')
  }
  return {
    operationKey: intent.operationKey,
    expectedVersion: intent.version,
    expectedRevision: conversation.revision,
    expectedContextGeneration: conversation.contextGeneration,
    expectedActivationFence: conversation.activationFence,
    expectedNativeBindingGeneration: intent.nativeBindingGeneration,
    deliveryReceiptId: intent.deliveryReceiptId,
    sourceBoundaries: intent.sourceBoundaries
  }
}
it('creates A-B-A activation segments and parks records without hiding or changing their identity', async () => {
  const a = records.getRecord('session-a')
  const b = records.getRecord('session-b')
  const first = await records.conversations.activate(await ready())
  expect(records.conversations.route('session-a').role).toBe('parked')
  expect(records.conversations.route('session-b').role).toBe('active')
  const back = await records.conversations.activate(await ready('session-a', 'c'))
  expect(back.contextGeneration).toBe(1)
  expect(back.activationFence).toBe(3)
  expect(records.conversations.segments(first.conversationId).map((s) => s.sessionId)).toEqual([
    'session-a',
    'session-b',
    'session-a'
  ])
  expect(records.getRecord('session-a')).toEqual(a)
  expect(records.getRecord('session-b')).toEqual(b)
  const replay = await records.admitOperation(operation('c'))
  expect(replay.decision).toBe('replay')
  if (replay.decision === 'replay') {
    expect(replay.row.outcome).toMatchObject({ status: 'succeeded', conversationActivation: back })
  }
})
it('rejects source and generation drift before active-pointer or ledger settlement', async () => {
  const request = await ready()
  await expect(
    records.conversations.activate({ ...request, expectedNativeBindingGeneration: 2 })
  ).rejects.toThrow('stale-generation')
  await expect(
    records.conversations.activate({ ...request, expectedContextGeneration: 2 })
  ).rejects.toThrow('stale-generation')
  await expect(
    records.conversations.activate({ ...request, expectedActivationFence: 2 })
  ).rejects.toThrow('stale-generation')
  append('session-a', 2)
  await expect(records.conversations.activate(request)).rejects.toThrow('stale-source')
  expect(records.conversations.route('session-a').role).toBe('active')
  expect(records.conversations.route('session-b').role).toBe('candidate')
})
it('never treats a receipt string as native acceptance', async () => {
  const request = await ready()
  openTestJournalHostDatabase(root).db.exec('DELETE FROM test_verified_delivery')
  await expect(records.conversations.activate(request)).rejects.toThrow('unverified-delivery')
})
it('does not adopt ledger or aggregate state when COMMIT fails', async () => {
  const request = await ready()
  const db = openTestJournalHostDatabase(root).db
  const exec = db.exec.bind(db)
  vi.spyOn(db, 'exec').mockImplementation((sql) => {
    if (sql === 'COMMIT') {
      throw new Error('disk full')
    }
    return exec(sql)
  })
  await expect(records.conversations.activate(request)).rejects.toThrow('disk full')
  vi.restoreAllMocks()
  expect(records.conversations.route('session-a').role).toBe('active')
  const replay = await records.admitOperation(operation('b'))
  if (replay.decision !== 'replay') {
    throw new Error('missing ledger replay')
  }
  expect(replay.row.outcome.status).toBe('unknown')
  const result = await records.conversations.activate(request)
  expect(result.activationFence).toBe(2)
})
it('refuses wrong account or provider before binding the target', async () => {
  const conversation = await records.conversations.ensureSingleton('session-a')
  const request = {
    conversationId: conversation.conversationId,
    expectedRevision: 1,
    expectedContextGeneration: 1,
    expectedActivationFence: 1,
    target: { ...identity('session-b'), accountHome: { variable: 'AGENT_HOME', path: '/other' } },
    expectedNativeBindingGeneration: 1
  }
  await expect(records.conversations.beginSwitch(request, operation('d'))).rejects.toThrow(
    'identity-mismatch'
  )
  expect(records.conversations.membership('session-b')).toBeNull()
  await expect(
    records.conversations.beginSwitch(
      { ...request, target: identity('session-b', 'claude') },
      operation('d')
    )
  ).rejects.toThrow('identity-mismatch')
})

it('keeps interleaved late A1 evidence out of the returning A3 segment and pages stable references', async () => {
  const conversation = await records.conversations.ensureSingleton('session-a')
  const original = conversation.activeSegmentId
  await records.conversations.activate(await ready())
  const returned = await records.conversations.activate(await ready('session-a', 'c'))
  const host = openTestJournalHostDatabase(root)
  for (const [seq, segmentId] of [
    [2, returned.segmentId],
    [3, original]
  ] as const) {
    host.transaction((db) => {
      const row = {
        kind: 'epoch' as const,
        reason: 'session_created' as const,
        providerHandle: { kind: 'codex' as const, threadId: 'session-a' },
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch: 'epoch-session-a',
        seq,
        fence: 1,
        ts: seq
      }
      insertJournalRow(db, 'session-a', row)
      records.conversations.sourceAttributionReceipt(segmentId, 'session-a', 1).write(db, row)
    })
  }
  const page = records.conversations.timelinePage(conversation.conversationId)
  expect(
    page
      .filter((r) => r.source.sessionId === 'session-a')
      .map((r) => [r.source.sequence, r.segmentId])
  ).toEqual([
    [1, original],
    [3, original],
    [2, returned.segmentId]
  ])
  expect(
    records.conversations.timelinePage(conversation.conversationId, page[0].cursor, 1)
  ).toEqual([page[1]])
})

it('fences late parked B evidence in A-B-A-C before activation', async () => {
  await records.conversations.activate(await ready())
  await records.conversations.activate(await ready('session-a', 'c'))
  const request = await ready('session-c', 'd')
  append('session-b', 2)
  await expect(records.conversations.activate(request)).rejects.toThrow('stale-source')
  expect(records.conversations.route('session-a').role).toBe('active')
})
it('fences a late append to a retained noncurrent source epoch', async () => {
  const conversation = await records.conversations.ensureSingleton('session-a')
  const host = openTestJournalHostDatabase(root)
  host.transaction((db) => {
    const row = {
      kind: 'epoch' as const,
      reason: 'session_created' as const,
      providerHandle: { kind: 'codex' as const, threadId: 'session-a' },
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      epoch: 'replacement',
      seq: 1,
      fence: 1,
      ts: 1
    }
    deleteJournalEpochRows(db, 'session-a', 'epoch-session-a')
    insertJournalRow(db, 'session-a', row)
    records.conversations
      .sourceAttributionReceipt(
        conversation.activeSegmentId,
        'session-a',
        conversation.contextGeneration
      )
      .write(db, row)
    publishJournalSessionEpoch(db, { sessionId: 'session-a', workspaceId: 'folder' }, 'replacement')
  })
  const request = await ready()
  append('session-a', 2)
  await expect(records.conversations.activate(request)).rejects.toThrow('stale-source')
})
it('refuses unaccounted candidate writes after verified readback', async () => {
  const request = await ready()
  append('session-b', 2)
  await expect(records.conversations.activate(request)).rejects.toThrow('unverified-delivery')
})
it('leaves an unresolved expired ledger intent blocked instead of authorizing replay', async () => {
  const request = await ready()
  await records.admitOperation({
    ...operation('e'),
    now: now + 365 * 24 * 60 * 60 * 1000,
    operationId: `${now + 365 * 24 * 60 * 60 * 1000}-${'e'.repeat(32)}`
  })
  await expect(records.conversations.activate(request)).rejects.toThrow('expired-intent')
  expect(records.conversations.route('session-a').role).toBe('active')
})

it('rejects attribution from a different session or context generation', async () => {
  const conversation = await records.conversations.ensureSingleton('session-a')
  const host = openTestJournalHostDatabase(root)
  const row = {
    kind: 'epoch' as const,
    reason: 'session_created' as const,
    providerHandle: { kind: 'codex' as const, threadId: 'session-a' },
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: 'epoch-session-a',
    seq: 1,
    fence: 1,
    ts: 1
  }
  expect(() =>
    host.transaction((db) =>
      records.conversations
        .sourceAttributionReceipt(conversation.activeSegmentId, 'session-b', 1)
        .write(db, row)
    )
  ).toThrow('identity-mismatch')
  expect(() =>
    host.transaction((db) =>
      records.conversations
        .sourceAttributionReceipt(conversation.activeSegmentId, 'session-a', 2)
        .write(db, row)
    )
  ).toThrow('identity-mismatch')
})
it('pins the existing candidate epoch before its first rollover', async () => {
  await prepareSwitch()
  const host = openTestJournalHostDatabase(root)
  host.transaction((db) => {
    deleteJournalEpochRows(db, 'session-b', 'epoch-session-b')
    insertJournalRow(db, 'session-b', {
      kind: 'epoch',
      reason: 'session_created',
      providerHandle: { kind: 'codex', threadId: 'session-b' },
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      epoch: 'new-candidate',
      seq: 1,
      fence: 1,
      ts: 1
    })
    publishJournalSessionEpoch(
      db,
      { sessionId: 'session-b', workspaceId: 'folder' },
      'new-candidate'
    )
  })
  expect(readJournalRowsAfter(host.db, 'session-b', 'epoch-session-b', 0)).toHaveLength(1)
})

it('returns to a participant whose retained epoch grew without extending an existing frozen pin', async () => {
  await records.conversations.activate(await ready())
  append('session-b', 2)
  await records.conversations.activate(await ready('session-a', 'c'))
  expect(
    (await records.conversations.activate(await ready('session-b', 'd'))).activationFence
  ).toBe(4)
})

it('starts a returning segment rollover span at one rather than the previous epoch cursor', async () => {
  append('session-a', 2)
  await records.conversations.activate(await ready())
  const returned = await records.conversations.activate(await ready('session-a', 'c'))
  const host = openTestJournalHostDatabase(root)
  host.transaction((db) => {
    deleteJournalEpochRows(db, 'session-a', 'epoch-session-a')
    insertJournalRow(db, 'session-a', {
      kind: 'epoch',
      reason: 'session_created',
      providerHandle: { kind: 'codex', threadId: 'session-a' },
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      epoch: 'returned-epoch',
      seq: 1,
      fence: 1,
      ts: 1
    })
    publishJournalSessionEpoch(
      db,
      { sessionId: 'session-a', workspaceId: 'folder' },
      'returned-epoch'
    )
  })
  await records.conversations.activate(await ready('session-b', 'd'))
  const span = records.conversations
    .sourceSpans(returned.segmentId)
    .find((value) => value.epoch === 'returned-epoch')
  expect(span).toMatchObject({ startSequence: 1, endSequence: 1 })
  expect(
    records.conversations
      .timelinePage(returned.conversationId)
      .filter((value) => value.source.epoch === 'returned-epoch')
  ).toMatchObject([{ segmentId: returned.segmentId, source: { sequence: 1 } }])
})

it('reserves a durable inactive candidate segment before any target submission', async () => {
  const conversation = await records.conversations.ensureSingleton('session-a')
  const request = {
    conversationId: conversation.conversationId,
    expectedRevision: conversation.revision,
    expectedContextGeneration: 1,
    expectedActivationFence: 1,
    target: identity('session-b'),
    expectedNativeBindingGeneration: 1
  }
  const admitted = await records.conversations.beginSwitch(request, operation('cade'))
  expect(admitted.intent).toHaveProperty('candidateSegmentId', expect.any(String))
  const segments = records.conversations.segments(conversation.conversationId)
  const candidate = segments.find((segment) => segment.sessionId === 'session-b')
  expect(candidate).toMatchObject({ lifecycle: 'candidate', activationFence: 2 })
  expect(records.conversations.read(conversation.conversationId)?.activeSegmentId).toBe(
    conversation.activeSegmentId
  )
  const replay = await records.conversations.beginSwitch(request, operation('cade'))
  expect(replay.intent).toEqual(admitted.intent)
  expect(records.conversations.segments(conversation.conversationId)).toHaveLength(2)
})

it('records reconciliation despite late source revisions without rewriting frozen evidence', async () => {
  const { prepared } = await prepareSwitch('session-b', 'dead')
  append('session-a', 2)
  const marked = await records.conversations.markReconciliation(
    prepared.operationKey,
    prepared.version
  )
  expect(marked.phase).toBe('reconciliation-required')
  expect(marked.sourceBoundaries).toEqual(prepared.sourceBoundaries)
  expect(marked.manifestId).toBe(prepared.manifestId)
  expect(marked.candidateBaseline).toEqual(prepared.candidateBaseline)
  await expect(
    records.conversations.markReconciliation(prepared.operationKey, prepared.version)
  ).rejects.toThrow()
})

it('excludes a candidate with no attributed effects from another target source boundary set', async () => {
  const { conversation } = await prepareSwitch('session-b', 'beef')
  const { readConversationDeliverySources } = await import('./conversation-read-model')
  const sources = readConversationDeliverySources(
    openTestJournalHostDatabase(root).db,
    conversation.conversationId,
    'session-c'
  )
  expect(sources.map((source) => source.sessionId)).toEqual(['session-a'])
})

it('enrolls only the frozen initial prefix as original segment history', async () => {
  const conversation = await records.conversations.ensureSingleton('session-a')
  const { readConversationEnrollmentOrigin } = await import('./conversation-origin-capture')
  const db = openTestJournalHostDatabase(root).db
  expect(
    readConversationEnrollmentOrigin(db, {
      sessionId: 'session-a',
      epoch: 'epoch-session-a',
      sequence: 1
    })
  ).toMatchObject({
    segmentId: conversation.activeSegmentId,
    contextGeneration: 1,
    nativeBindingGeneration: 1
  })
  append('session-a', 2)
  expect(
    readConversationEnrollmentOrigin(db, {
      sessionId: 'session-a',
      epoch: 'epoch-session-a',
      sequence: 2
    })
  ).toBeNull()
})

it('commits verified coverage before activation and rolls both back on failure', async () => {
  const request = await ready()
  const host = openTestJournalHostDatabase(root)
  host.db.exec('CREATE TABLE test_committed_coverage(id TEXT PRIMARY KEY)')
  commitDelivery = () => {
    expect(records.conversations.route('session-a').role).toBe('active')
    host.db.prepare('INSERT INTO test_committed_coverage VALUES(?)').run('coverage')
    throw new Error('coverage commit failed')
  }
  await expect(records.conversations.activate(request)).rejects.toThrow('coverage commit failed')
  expect(host.db.prepare('SELECT COUNT(*) n FROM test_committed_coverage').get()?.n).toBe(0)
  expect(records.conversations.route('session-a').role).toBe('active')
  expect(records.conversations.intent(request.operationKey)?.phase).toBe('delivering')
  commitDelivery = () => {
    expect(records.conversations.route('session-a').role).toBe('active')
    host.db.prepare('INSERT INTO test_committed_coverage VALUES(?)').run('coverage')
  }
  await records.conversations.activate(request)
  expect(host.db.prepare('SELECT COUNT(*) n FROM test_committed_coverage').get()?.n).toBe(1)
  expect(records.conversations.route('session-b').role).toBe('active')
})

it('captures an already proven target owner only after immutable target identity matches', async () => {
  await records.reconcileOnRestart({ probe: async () => ({ outcome: 'reservation-unused' }), now })
  const target = records.getRecord('session-b')!
  const reserved = await records.reserveOwner({
    ...identity('session-b'),
    expectedFence: target.lease.runtimeFence,
    spawnToken: 'candidate-process',
    claimKeyId: 'candidate-key',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'owner',
      operationId: `${now}-000000000000000000000000000000ee`,
      fingerprint: 'candidate-owner'
    },
    now
  })
  const fence = reserved.record.lease.runtimeFence
  await records.commitProcessIdentity({
    sessionId: 'session-b',
    fence,
    process: {
      hostId: 'local',
      pid: 4243,
      processStartTimeMs: now,
      spawnToken: 'candidate-process'
    },
    now
  })
  await records.proveOwner({
    sessionId: 'session-b',
    fence,
    now,
    link: {
      linkId: 'candidate-native',
      handle: codexProviderHandle('native-candidate'),
      origin: 'created',
      mintedAtFence: fence,
      observedAt: now
    }
  })
  const conversation = await records.conversations.ensureSingleton('session-a')
  const request = {
    conversationId: conversation.conversationId,
    expectedRevision: conversation.revision,
    expectedContextGeneration: 1,
    expectedActivationFence: 1,
    expectedNativeBindingGeneration: 1,
    target: identity('session-b')
  }
  await expect(
    records.conversations.beginSwitch(
      {
        ...request,
        target: {
          ...request.target,
          accountHome: { variable: 'AGENT_HOME', path: '/wrong-account' }
        }
      },
      operation('ab')
    )
  ).rejects.toThrow('identity-mismatch')
  const db = openTestJournalHostDatabase(root).db
  expect(
    db.prepare('SELECT 1 FROM conversation_origin_acquisitions WHERE session_id=?').get('session-b')
  ).toBeUndefined()
  const { intent } = await records.conversations.beginSwitch(request, operation('ac'))
  if (!intent) {
    throw new Error('missing candidate intent')
  }
  const acquisition = db
    .prepare(
      'SELECT origin_json FROM conversation_origin_acquisitions WHERE session_id=? AND fence=?'
    )
    .get('session-b', fence)
  expect(acquisition).toBeDefined()
  expect(JSON.parse(String(acquisition?.origin_json))).toEqual({
    conversationId: conversation.conversationId,
    segmentId: intent.candidateSegmentId,
    contextGeneration: 1,
    nativeBindingGeneration: 1
  })
  expect(
    records.conversations
      .segments(conversation.conversationId)
      .find((s) => s.segmentId === intent.candidateSegmentId)?.lifecycle
  ).toBe('candidate')
  expect(
    db.prepare('SELECT 1 FROM conversation_origin_bindings WHERE session_id=?').get('session-b')
  ).toBeUndefined()
  const current = records.conversations.read(conversation.conversationId)!
  await records.conversations.cancel({
    operationKey: intent.operationKey,
    expectedVersion: intent.version,
    expectedRevision: current.revision,
    expectedContextGeneration: 1,
    expectedActivationFence: 1
  })
  const next = await records.conversations.beginSwitch(
    {
      ...request,
      expectedRevision: records.conversations.read(conversation.conversationId)!.revision
    },
    operation('ad')
  )
  expect(next.intent?.candidateSegmentId).not.toBe(intent.candidateSegmentId)
  // Acquisition stores scope only: a retained native writer does not retag earlier message identities.
  expect(
    db
      .prepare(
        'SELECT origin_json FROM conversation_origin_acquisitions WHERE session_id=? AND fence=?'
      )
      .get('session-b', fence)
  ).toEqual(acquisition)
})
