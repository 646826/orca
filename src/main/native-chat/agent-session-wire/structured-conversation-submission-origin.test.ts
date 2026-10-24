import { appendConversationClearJournals } from '../conversations/conversation-clear-journals'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import {
  fakeCodexAppServer,
  echoUserMessage
} from '../../codex/codex-structured-dispatch-test-support'
import { acquireReadyCodexForTest } from '../../codex/codex-structured-session-adapter-fixture'
import { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import { freezeConversationPreparationSources } from '../conversations/conversation-preparation-sources'
import { exportConversationContext } from '../conversations/conversation-context-export'
import { readConversationRowOrigins } from '../conversations/conversation-origin-rows'
import { readConversationSourceSegmentId } from '../conversations/conversation-source-attribution'
import {
  hostTestState,
  CALLER,
  envelope,
  attach
} from './structured-agent-session-host-test-harness'
import type { JournalOperationReceipt } from '../agent-session-journal/journal-row-writer'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  HOST_TEST_NOW,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { beginSwitch } from './structured-conversation-switch.test-fixture'

async function capturedSwitch(queued = false) {
  const f = await beginSwitch(async () => {
    const { host, acquire, dispatch } = hostTestState()
    await host.conversationEnrollment.ensure(HOST_TEST_SESSION)
    let turn = 0
    const codex = fakeCodexAppServer({
      'thread/start': () => ({ thread: { id: HOST_TEST_THREAD } }),
      'thread/resume': () => ({ thread: { id: HOST_TEST_THREAD } }),
      'turn/start': () => ({ turn: { id: `captured-turn-${++turn}` } })
    })

    const settlements: Promise<void>[] = []
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: '/work/repo',
        codexHome: null,
        resumeThreadId: null
      }),
      openConnection: codex.openConnection,
      readProcessStartTime: async () => 1700000000000,
      now: () => 1700000000500,
      onDispatchSettledLate: (value) => {
        settlements.push(host.settleLateDispatch(value))
      }
    })
    const acquisition = acquire.mock.calls[0]![0]
    await acquireReadyCodexForTest(adapter, { ...acquisition, onSpawned: undefined })
    dispatch.mockImplementation((input) => adapter.dispatch(input))
    try {
      const body = hostTestMessage('Preserve native lifecycle evidence 日本語🙂')
      const pending = host.send(CALLER, {
        envelope: envelope('agentSession.send', { body }),
        body,
        userSend: true
      })
      await vi.waitFor(() =>
        expect(codex.connections[0]!.calls.some((call) => call.method === 'turn/start')).toBe(true)
      )
      const connection = codex.connections[0]!
      const clientId = host
        .collaboratorsForTests()
        .sessions.get(HOST_TEST_SESSION)!
        .journal.submissions()[0]!.clientMessageId
      connection.handlers.onNotification?.('turn/started', {
        threadId: HOST_TEST_THREAD,
        turn: { id: 'captured-turn-1' }
      })
      echoUserMessage(connection, {
        threadId: HOST_TEST_THREAD,
        turnId: 'captured-turn-1',
        itemId: 'captured-user',
        clientId
      })
      expect(await pending).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(settlements.length).toBeGreaterThan(0))
      await Promise.all(settlements)
      if (queued) {
        const body = hostTestMessage('queued admitted intent 日本語🙂')
        expect(
          await host.send(CALLER, {
            envelope: envelope('agentSession.send', { body, delivery: 'queue-if-active' }),
            body,
            delivery: 'queue-if-active',
            userSend: true
          })
        ).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })
      }
      connection.handlers.onNotification?.('turn/completed', {
        threadId: HOST_TEST_THREAD,
        turn: { id: 'captured-turn-1', status: 'completed' }
      })
      await host.flushStreamedEvents(HOST_TEST_SESSION)
      if (queued) {
        await vi.waitFor(() =>
          expect(connection.calls.filter((call) => call.method === 'turn/start')).toHaveLength(2)
        )
        const journal = host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
        const queuedSubmission = journal.submissions()[1]!
        connection.handlers.onNotification?.('turn/started', {
          threadId: HOST_TEST_THREAD,
          turn: { id: 'captured-turn-2' }
        })
        echoUserMessage(connection, {
          threadId: HOST_TEST_THREAD,
          turnId: 'captured-turn-2',
          itemId: 'queued-user',
          clientId: queuedSubmission.clientMessageId
        })
        await vi.waitFor(async () => {
          await Promise.all(settlements)
          expect(journal.receiptFor(queuedSubmission.clientMessageId)?.originCorrelation).toBe(
            'exact'
          )
        })
        connection.handlers.onNotification?.('turn/completed', {
          threadId: HOST_TEST_THREAD,
          turn: { id: 'captured-turn-2', status: 'completed' }
        })
        await host.flushStreamedEvents(HOST_TEST_SESSION)
        expect(journal.queuedMessages.list().filter((draft) => draft.state === 'waiting')).toEqual(
          []
        )
      }
    } finally {
      await adapter.closeAll()
    }
  })
  const db = f.host.deps.journalDatabase.db
  const batch = db
    .prepare(
      "SELECT epoch,seq,row_json FROM journal_rows WHERE session_id=? AND json_extract(row_json,'$.kind')='lifecycle-batch' ORDER BY seq DESC"
    )
    .get(HOST_TEST_SESSION)
  if (
    typeof batch?.row_json !== 'string' ||
    typeof batch.epoch !== 'string' ||
    typeof batch.seq !== 'number'
  ) {
    throw new Error('missing captured native lifecycle batch')
  }
  const source = { sessionId: HOST_TEST_SESSION, epoch: batch.epoch, sequence: batch.seq }
  const sha256 = createHash('sha256').update(batch.row_json).digest('hex')
  return { ...f, db, source, raw: batch.row_json, sha256 }
}

it.each([false, true])(
  'binds an ordinary admitted native send and its exact lifecycle descendants before switching (queued: %s)',
  async (queued) => {
    const f = await capturedSwitch(queued)
    expect(
      f.db
        .prepare(
          'SELECT atom_path,origin_json FROM conversation_origin_rows WHERE session_id=? AND origin_json IS NULL'
        )
        .all(HOST_TEST_SESSION)
    ).toEqual([])
    const origins = readConversationRowOrigins(f.db, f.source)
    expect(origins.length).toBeGreaterThan(1)
    expect(origins.every(({ origin }) => origin.conversationId === f.intent.conversationId)).toBe(
      true
    )
    expect(f.db.prepare('SELECT count(*) n FROM conversation_source_atoms').get()?.n).toBe(0)
    const snapshot = await freezeConversationPreparationSources(
      f.db,
      f.intent,
      new AbortController().signal
    )
    const { root, store: records } = hostTestState()
    const exported = await exportConversationContext({
      db: f.db,
      stateDirectory: root,
      store: new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(root), {
        hasSession: (id) => records.getRecord(id) !== null
      }),
      conversationId: f.intent.conversationId,
      contextGeneration: f.intent.contextGeneration,
      sources: [
        {
          source: f.source,
          segmentId: readConversationSourceSegmentId(f.db, f.source)!,
          pinOwnerId: snapshot.ownerId,
          decision: 'include',
          critical: true
        }
      ],
      disclosure: {
        targetBindingDigest: 'a'.repeat(64),
        resolve: () => ({
          version: { source: f.source, sha256: f.sha256 },
          contextGeneration: f.intent.contextGeneration,
          targetBindingDigest: 'a'.repeat(64),
          action: 'include',
          reason: 'user-policy',
          critical: true
        })
      }
    })
    const row = exported.rows[0]!
    expect(
      (await readFile(exported.artifact.path))
        .subarray(row.byteOffset, row.byteOffset + row.byteLength)
        .toString()
    ).toBe(f.raw)
    expect(readConversationRowOrigins(f.db, f.source)).toEqual(origins)
    expect(
      f.db
        .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?')
        .get(f.source.sessionId, f.source.epoch, f.source.sequence)?.row_json
    ).toBe(f.raw)
    expect(
      f.db
        .prepare(
          'SELECT count(*) n FROM conversation_source_atoms WHERE session_id=? AND epoch=? AND sequence=?'
        )
        .get(f.source.sessionId, f.source.epoch, f.source.sequence)?.n
    ).toBe(origins.length)
  }
)

async function activeAdmission() {
  await attach()
  const f = hostTestState()
  const conversation = await f.host.conversationEnrollment.ensure(HOST_TEST_SESSION)
  f.host.stopDelivery()
  const journal = f.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
  return { ...f, conversation, journal, db: f.host.deps.journalDatabase.db }
}

it('admits a cold ordinary message before reacquiring a provider without reusing an old acquisition fence', async () => {
  const f = await activeAdmission()
  await f.host.close(HOST_TEST_SESSION, 'evict')
  expect(f.store.getRecord(HOST_TEST_SESSION)!.lease.claimStatus).toBe('released')
  const body = hostTestMessage('cold admitted message')
  const request = envelope('agentSession.send', { body })
  expect(await f.host.send(CALLER, { envelope: request, body, userSend: true })).toMatchObject({
    ok: true
  })
  const journal = f.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
  const submission = journal.submission(request.clientOperationId)!
  if (typeof submission.submittedSequence !== 'number') {
    throw new Error('missing admitted submission sequence')
  }
  expect(
    readConversationRowOrigins(f.db, {
      sessionId: HOST_TEST_SESSION,
      epoch: journal.cursor().epoch,
      sequence: submission.submittedSequence
    })
  ).toMatchObject([{ atomPath: '$', origin: { segmentId: f.conversation.activeSegmentId } }])
  expect(f.acquire).toHaveBeenCalledOnce()
})

it.each(['missing-acquisition', 'stale-native', 'wrong-fence'] as const)(
  'rejects %s at the ordinary submission receipt',
  async (scenario) => {
    const f = await activeAdmission()
    const receipt = f.store.submissionReceipt(HOST_TEST_SESSION)
    const fence = f.store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
    if (scenario === 'missing-acquisition') {
      f.db
        .prepare('DELETE FROM conversation_origin_acquisitions WHERE session_id=? AND fence=?')
        .run(HOST_TEST_SESSION, fence)
    } else if (scenario === 'stale-native') {
      f.db
        .prepare(
          "UPDATE conversation_origin_acquisitions SET native_identity='foreign-native' WHERE session_id=? AND fence=?"
        )
        .run(HOST_TEST_SESSION, fence)
    }
    const before = f.journal.cursor()
    await expect(
      f.journal.appendSubmission(
        {
          clientMessageId: 'rejected-origin',
          payloadFingerprint: 'rejected-origin',
          body: hostTestMessage('must not bind'),
          fence: scenario === 'wrong-fence' ? fence + 1 : fence
        },
        undefined,
        receipt
      )
    ).rejects.toThrow('scope-mismatch')
    expect(f.journal.cursor()).toEqual(before)
    expect(
      f.db
        .prepare(
          "SELECT 1 FROM conversation_origin_bindings WHERE session_id=? AND key_kind='submission' AND key_id='rejected-origin'"
        )
        .get(HOST_TEST_SESSION)
    ).toBeUndefined()
  }
)

it('rolls back ordinary submission binding and acceptance when the required origin write fails', async () => {
  const f = await activeAdmission()
  f.db.exec(
    "CREATE TRIGGER reject_admitted_origin BEFORE INSERT ON conversation_origin_rows BEGIN SELECT RAISE(ABORT,'origin storage unavailable'); END"
  )
  const body = hostTestMessage('atomic user admission')
  const request = envelope('agentSession.send', { body })
  expect(await f.host.send(CALLER, { envelope: request, body, userSend: true })).toMatchObject({
    ok: false
  })
  expect(f.journal.submission(request.clientOperationId)).toBeUndefined()
  expect(
    f.db
      .prepare(
        "SELECT 1 FROM conversation_origin_bindings WHERE session_id=? AND key_kind='submission' AND key_id=?"
      )
      .get(HOST_TEST_SESSION, request.clientOperationId)
  ).toBeUndefined()
  expect(f.store.readCommandReceipt({ kind: 'global' }, request.clientOperationId)).toEqual({
    verdict: 'absent'
  })
  expect(f.dispatch).not.toHaveBeenCalled()
})

it('does not consume a delayed queued send after switching begins', async () => {
  let receipt: JournalOperationReceipt | undefined
  const f = await beginSwitch(async () => {
    const { host, store } = hostTestState()
    await host.conversationEnrollment.ensure(HOST_TEST_SESSION)
    host.stopDelivery()
    receipt = store.submissionReceipt(HOST_TEST_SESSION)
    await host
      .collaboratorsForTests()
      .sessions.get(HOST_TEST_SESSION)!
      .journal.queuedMessages.insert({
        messageId: 'delayed-draft',
        body: hostTestMessage('retained draft')
      })
  })
  const journal = f.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
  await expect(
    journal.appendSubmission(
      {
        clientMessageId: 'delayed-submission',
        payloadFingerprint: journal.queuedMessages.get('delayed-draft')!.fingerprint,
        body: hostTestMessage('retained draft'),
        fence: f.store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
      },
      {
        messageId: 'delayed-draft',
        expect: 'waiting'
      },
      receipt
    )
  ).rejects.toThrow('scope-mismatch')
  expect(journal.queuedMessages.get('delayed-draft')?.state).toBe('waiting')
  expect(journal.submission('delayed-submission')).toBeUndefined()
})

it.each(['candidate', 'parked'] as const)(
  'does not use an ordinary admission receipt for a %s participant',
  async (role) => {
    const f = await beginSwitch()
    f.host.stopDelivery()
    if (role === 'parked') {
      const conversation = f.store.conversations.read(f.intent.conversationId)!
      await f.store.conversations.cancel({
        operationKey: f.intent.operationKey,
        expectedVersion: f.intent.version,
        expectedRevision: conversation.revision,
        expectedContextGeneration: conversation.contextGeneration,
        expectedActivationFence: conversation.activationFence
      })
    }
    expect(f.store.conversations.route(f.targetId).role).toBe(role)
    const journal = f.host.collaboratorsForTests().sessions.get(f.targetId)!.journal
    const receipt = f.store.submissionReceipt(f.targetId)
    await expect(
      journal.appendSubmission(
        {
          clientMessageId: 'blocked-participant',
          payloadFingerprint: 'blocked',
          body: hostTestMessage('must not send'),
          fence: f.store.getRecord(f.targetId)!.lease.runtimeFence
        },
        undefined,
        receipt
      )
    ).rejects.toThrow('scope-mismatch')
    expect(journal.submission('blocked-participant')).toBeUndefined()
  }
)

it('does not move an admitted source receipt to another session journal', async () => {
  let receipt: JournalOperationReceipt | undefined
  const f = await beginSwitch(async () => {
    const { host, store } = hostTestState()
    await host.conversationEnrollment.ensure(HOST_TEST_SESSION)
    receipt = store.submissionReceipt(HOST_TEST_SESSION)
  })
  f.host.stopDelivery()
  const conversation = f.store.conversations.read(f.intent.conversationId)!
  await f.store.conversations.cancel({
    operationKey: f.intent.operationKey,
    expectedVersion: f.intent.version,
    expectedRevision: conversation.revision,
    expectedContextGeneration: conversation.contextGeneration,
    expectedActivationFence: conversation.activationFence
  })
  const journal = f.host.collaboratorsForTests().sessions.get(f.targetId)!.journal
  await expect(
    journal.appendSubmission(
      {
        clientMessageId: 'foreign-journal',
        payloadFingerprint: 'foreign',
        body: hostTestMessage('must not move'),
        fence: f.store.getRecord(f.targetId)!.lease.runtimeFence
      },
      undefined,
      receipt
    )
  ).rejects.toThrow('missing-source')
  expect(journal.submission('foreign-journal')).toBeUndefined()
})

it('keeps a delayed old-generation queued send unconsumed after an actual aggregate clear', async () => {
  const f = await activeAdmission()
  await f.host.close(HOST_TEST_SESSION, 'evict')
  await f.host.journalSnapshot(HOST_TEST_SESSION)
  const journal = f.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
  const receipt = f.store.submissionReceipt(HOST_TEST_SESSION)
  await journal.queuedMessages.insert({
    messageId: 'before-clear',
    body: hostTestMessage('old generation')
  })
  const begun = await f.store.conversations.clear.begin(
    {
      conversationId: f.conversation.conversationId,
      expectedRevision: f.conversation.revision,
      expectedContextGeneration: f.conversation.contextGeneration,
      expectedActivationFence: f.conversation.activationFence
    },
    {
      callerKey: CALLER.callerKey,
      operationId: hostTestOperationId(),
      fingerprint: 'clear-origin',
      now: HOST_TEST_NOW
    }
  )
  const prepared = await f.store.conversations.clear.prepare({
    operationKey: begun.intent!.operationKey,
    expectedVersion: begun.intent!.version
  })
  await appendConversationClearJournals({
    journals: [journal],
    clear: f.store.conversations.clear,
    activeSessionId: HOST_TEST_SESSION,
    operationKey: prepared.operationKey,
    expectedVersion: prepared.version,
    now: HOST_TEST_NOW,
    isCurrent: (current) => current === journal
  })
  expect(f.store.conversations.read(f.conversation.conversationId)?.contextGeneration).toBe(2)
  const input = {
    clientMessageId: 'after-clear-stale',
    payloadFingerprint: journal.queuedMessages.get('before-clear')!.fingerprint,
    body: hostTestMessage('old generation'),
    fence: f.store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
  }
  await expect(journal.appendSubmission(input, undefined, receipt)).rejects.toThrow(
    'scope-mismatch'
  )
  await expect(
    journal.appendSubmission(input, { messageId: 'before-clear', expect: 'waiting' }, receipt)
  ).rejects.toThrow()
  expect(journal.queuedMessages.get('before-clear')).toMatchObject({
    state: 'waiting',
    holdReason: 'context_generation_changed'
  })
  expect(journal.submission('after-clear-stale')).toBeUndefined()
  const body = hostTestMessage('new generation cold admission')
  const request = envelope('agentSession.send', { body })
  expect(await f.host.send(CALLER, { envelope: request, body, userSend: true })).toMatchObject({
    ok: true
  })
  const submission = journal.submission(request.clientOperationId)!
  if (typeof submission.submittedSequence !== 'number') {
    throw new Error('missing admitted submission sequence')
  }
  expect(
    readConversationRowOrigins(f.db, {
      sessionId: HOST_TEST_SESSION,
      epoch: journal.cursor().epoch,
      sequence: submission.submittedSequence
    })
  ).toMatchObject([{ atomPath: '$', origin: { contextGeneration: 2, nativeBindingGeneration: 2 } }])
  expect(f.acquire).toHaveBeenCalledOnce()
})
