import { agentSessionProviderHandleKey } from '../../../shared/agent-session-provider-handle'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import {
  fakeCodexAppServer,
  echoUserMessage
} from '../../codex/codex-structured-dispatch-test-support'
import { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import { freezeConversationPreparationSources } from '../conversations/conversation-preparation-sources'
import { exportConversationContext } from '../conversations/conversation-context-export'
import { readConversationRowOrigins } from '../conversations/conversation-origin-rows'
import { readConversationSourceSegmentId } from '../conversations/conversation-source-attribution'
import { beginSwitch } from './structured-conversation-switch.test-fixture'
import {
  hostTestState,
  CALLER,
  envelope,
  ensureParams,
  attach
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION,
  HOST_TEST_NOW,
  HOST_TEST_THREAD,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

const CLEARED_THREAD = '019fd532-7c11-7a90-b6de-4e1a2c3d5f62'

async function clearSource() {
  const f = hostTestState()
  f.host.deps.hasOpenDispatch = () => false
  const conversation = await f.host.conversationEnrollment.ensure(HOST_TEST_SESSION)
  const begun = await f.store.conversations.clear.begin(
    {
      conversationId: conversation.conversationId,
      expectedRevision: conversation.revision,
      expectedContextGeneration: conversation.contextGeneration,
      expectedActivationFence: conversation.activationFence
    },
    {
      callerKey: CALLER.callerKey,
      operationId: hostTestOperationId(),
      fingerprint: 'clear-new-native',
      now: HOST_TEST_NOW
    }
  )
  if (!begun.intent) {
    throw new Error('missing clear intent')
  }
  expect(
    await f.host.advanceConversationClear(begun.intent.operationKey, new AbortController().signal)
  ).toEqual({ kind: 'committed' })
  expect(f.store.getRecord(HOST_TEST_SESSION)?.providerHandleChain).toEqual([])
  return { ...f, conversation, clear: begun.intent, db: f.host.deps.journalDatabase.db }
}

it.each(['attach', 'ordinary-cold-send'] as const)(
  'reacquires a new native thread after committed clear via %s and exports only its new generation on switching',
  async (mode) => {
    let adapter: CodexStructuredSessionAdapter | undefined
    const f = await beginSwitch(async () => {
      const cleared = await clearSource()
      const { host, store, db } = cleared
      const archived = db
        .prepare(
          'SELECT * FROM conversation_origin_rows WHERE session_id=? ORDER BY sequence,atom_path'
        )
        .all(HOST_TEST_SESSION)
      const originalAdapter = host.deps.adapter
      const codex = fakeCodexAppServer({
        'thread/start': () => ({ thread: { id: CLEARED_THREAD } }),
        'turn/start': () => ({ turn: { id: 'after-clear-turn' } })
      })
      const settlements: Promise<void>[] = []
      adapter = new CodexStructuredSessionAdapter({
        resolveLaunch: async () => ({
          command: 'codex',
          args: ['app-server'],
          cwd: '/work/repo',
          codexHome: null,
          resumeThreadId: null
        }),
        openConnection: codex.openConnection,
        readProcessStartTime: async () => 1700000000000,
        now: () => HOST_TEST_NOW,
        onDispatchSettledLate: (value) => {
          settlements.push(host.settleLateDispatch(value))
        }
      })
      host.deps.adapter = adapter
      const nativeAdapter = adapter
      cleared.dispatch.mockImplementation((input) => nativeAdapter.dispatch(input))
      try {
        if (mode === 'attach') {
          expect(
            await host.attach(
              CALLER,
              ensureParams(store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence)
            )
          ).toMatchObject({ ok: true })
          await vi.waitFor(() =>
            expect(
              store.getRecord(HOST_TEST_SESSION)?.providerHandleChain.at(-1)?.handle.nativeId
            ).toBe(CLEARED_THREAD)
          )
        }
        const body = hostTestMessage('new clear generation native evidence 日本語🙂')
        const request = envelope('agentSession.send', { body })
        const sending = host.send(CALLER, { envelope: request, body, userSend: true })
        await vi.waitFor(() =>
          expect(codex.connections[0]?.calls.some((call) => call.method === 'turn/start')).toBe(
            true
          )
        )
        expect(
          store.getRecord(HOST_TEST_SESSION)?.providerHandleChain.at(-1)?.handle.nativeId
        ).toBe(CLEARED_THREAD)
        const connection = codex.connections[0]!
        connection.handlers.onNotification?.('turn/started', {
          threadId: CLEARED_THREAD,
          turn: { id: 'after-clear-turn' }
        })
        echoUserMessage(connection, {
          threadId: CLEARED_THREAD,
          turnId: 'after-clear-turn',
          itemId: 'after-clear-user',
          clientId: request.clientOperationId
        })
        expect(await sending).toMatchObject({ ok: true })
        await vi.waitFor(() => expect(settlements.length).toBeGreaterThan(0))
        await Promise.all(settlements)
        connection.handlers.onNotification?.('turn/completed', {
          threadId: CLEARED_THREAD,
          turn: { id: 'after-clear-turn', status: 'completed' }
        })
        await host.flushStreamedEvents(HOST_TEST_SESSION)
        for (const row of archived) {
          expect(
            db
              .prepare(
                'SELECT * FROM conversation_origin_rows WHERE session_id=? AND epoch=? AND sequence=? AND atom_path=?'
              )
              .get(HOST_TEST_SESSION, row.epoch, row.sequence, row.atom_path)
          ).toEqual(row)
        }
        expect(
          db
            .prepare(
              'SELECT 1 FROM conversation_origin_rows WHERE session_id=? AND origin_json IS NULL'
            )
            .get(HOST_TEST_SESSION)
        ).toBeUndefined()
      } finally {
        host.deps.adapter = originalAdapter
      }
    })
    try {
      const { root } = hostTestState()
      const db = f.host.deps.journalDatabase.db
      const batch = db
        .prepare(
          "SELECT epoch,seq,row_json FROM journal_rows WHERE session_id=? AND json_extract(row_json,'$.kind')='lifecycle-batch' ORDER BY seq DESC LIMIT 1"
        )
        .get(HOST_TEST_SESSION)
      if (
        typeof batch?.epoch !== 'string' ||
        typeof batch.seq !== 'number' ||
        typeof batch.row_json !== 'string'
      ) {
        throw new Error('missing after-clear batch')
      }
      const source = { sessionId: HOST_TEST_SESSION, epoch: batch.epoch, sequence: batch.seq }
      expect(readConversationRowOrigins(db, source)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            origin: expect.objectContaining({ contextGeneration: 2, nativeBindingGeneration: 2 })
          })
        ])
      )
      const sha256 = createHash('sha256').update(batch.row_json).digest('hex')
      const snapshot = await freezeConversationPreparationSources(
        db,
        f.intent,
        new AbortController().signal
      )
      const exported = await exportConversationContext({
        db,
        stateDirectory: root,
        store: new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(root), {
          hasSession: (id) => f.store.getRecord(id) !== null
        }),
        conversationId: f.intent.conversationId,
        contextGeneration: 2,
        sources: [
          {
            source,
            segmentId: readConversationSourceSegmentId(db, source)!,
            pinOwnerId: snapshot.ownerId,
            decision: 'include',
            critical: true
          }
        ],
        disclosure: {
          targetBindingDigest: 'a'.repeat(64),
          resolve: () => ({
            version: { source, sha256 },
            contextGeneration: 2,
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
      ).toBe(batch.row_json)
    } finally {
      await adapter?.closeAll()
    }
  }
)

async function linkedClear() {
  await attach()
  const f = await clearSource()
  const original = f.acquire.getMockImplementation()!
  f.acquire.mockImplementation(async (input) => {
    const acquired = await original(input)
    if (!acquired.link) {
      throw new Error('missing fixture link')
    }
    return { ...acquired, link: { ...acquired.link, handle: codexProviderHandle(CLEARED_THREAD) } }
  })
  return f
}

it('binds an acquired created link to the committed clear in the owner transaction', async () => {
  const f = await linkedClear()
  expect(
    await f.host.attach(
      CALLER,
      ensureParams(f.store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence)
    )
  ).toMatchObject({ ok: true })
  const record = f.store.getRecord(HOST_TEST_SESSION)!
  const captured = f.db
    .prepare(
      'SELECT origin_json,native_identity FROM conversation_origin_acquisitions WHERE session_id=? AND fence=?'
    )
    .get(HOST_TEST_SESSION, record.lease.runtimeFence)
  expect(JSON.parse(String(captured?.origin_json))).toMatchObject({
    contextGeneration: 2,
    nativeBindingGeneration: 2
  })
  expect(captured?.native_identity).toEqual(expect.any(String))
  expect(record.providerHandleChain).toHaveLength(1)
  expect(record.providerHandleChain[0]?.handle.nativeId).toBe(CLEARED_THREAD)
})

it.each([
  'missing-receipt',
  'foreign-boundary',
  'stale-generation',
  'cancelled-after-capture',
  'old-native',
  'rollback'
] as const)('rejects invalid clear acquisition authority: %s', async (mode) => {
  const f = await linkedClear()
  const acquisitions = f.acquire.mock.calls.length
  const original = f.acquire.getMockImplementation()!
  if (mode === 'missing-receipt') {
    f.db
      .prepare('DELETE FROM conversation_clear_rows WHERE operation_key=?')
      .run(f.clear.operationKey)
  }
  if (mode === 'foreign-boundary') {
    await f.store.transitionHandoff(HOST_TEST_SESSION, (record) => ({
      ...record,
      providerContextBoundary: { ...record.providerContextBoundary!, operationId: 'f'.repeat(64) }
    }))
  }
  if (mode === 'stale-generation') {
    f.db
      .prepare(
        "UPDATE conversation_participants SET record_json=json_set(record_json,'$.nativeBindingGeneration',3) WHERE session_id=?"
      )
      .run(HOST_TEST_SESSION)
  }
  if (mode === 'cancelled-after-capture') {
    f.acquire.mockImplementation(async (input) => {
      const acquired = await original(input)
      f.db
        .prepare(
          "UPDATE conversation_clear_intents SET record_json=json_set(record_json,'$.phase','cancelled') WHERE operation_key=?"
        )
        .run(f.clear.operationKey)
      return acquired
    })
  }
  if (mode === 'old-native') {
    f.acquire.mockImplementation(async (input) => {
      const acquired = await original(input)
      if (!acquired.link) {
        throw new Error('missing acquired link')
      }
      return {
        ...acquired,
        link: { ...acquired.link, handle: codexProviderHandle(HOST_TEST_THREAD) }
      }
    })
  }
  if (mode === 'rollback') {
    f.db.exec(
      "CREATE TRIGGER fail_clear_native_publish BEFORE UPDATE ON conversation_pending_native_identity WHEN NEW.native_identity IS NOT NULL BEGIN SELECT RAISE(ABORT,'clear native durable failure'); END"
    )
  }
  const attaching = f.host.attach(
    CALLER,
    ensureParams(f.store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence)
  )
  if (['missing-receipt', 'foreign-boundary', 'stale-generation'].includes(mode)) {
    await expect(attaching).rejects.toThrow('generation changed')
  } else {
    expect(await attaching).toMatchObject({ ok: false })
    const message =
      mode === 'rollback'
        ? 'clear native durable failure'
        : mode === 'old-native'
          ? 'cleared native identity'
          : 'generation changed'
    expect(
      f.log.entries.some(
        (entry) =>
          entry.fields.error instanceof Error && entry.fields.error.message.includes(message)
      )
    ).toBe(true)
  }
  expect(f.store.getRecord(HOST_TEST_SESSION)?.providerHandleChain).toEqual([])
  expect(
    f.db
      .prepare(
        "SELECT 1 FROM conversation_origin_acquisitions WHERE session_id=? AND json_extract(origin_json,'$.contextGeneration')=2"
      )
      .get(HOST_TEST_SESSION)
  ).toBeUndefined()
  expect(
    f.db
      .prepare('SELECT 1 FROM conversation_pending_native_identity WHERE session_id=?')
      .get(HOST_TEST_SESSION)
  ).toBeUndefined()
  if (['missing-receipt', 'foreign-boundary', 'stale-generation'].includes(mode)) {
    expect(f.acquire).toHaveBeenCalledTimes(acquisitions)
  }
})

it.each([1, 2, 'forked-chain'] as const)(
  'refuses reusing a retained cold native identity after %s clears without an acquisition',
  async (clears) => {
    await attach()
    const initial = hostTestState()
    if (clears === 'forked-chain') {
      const record = initial.store.getRecord(HOST_TEST_SESSION)!
      const child = initial.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.child!
      await initial.store.publishProviderHandle({
        sessionId: HOST_TEST_SESSION,
        fence: child.fence,
        acquisitionGeneration: child.generation!,
        now: HOST_TEST_NOW,
        link: {
          linkId: 'old-native-fork',
          handle: codexProviderHandle(CLEARED_THREAD),
          origin: 'forked',
          forkedFromKey: agentSessionProviderHandleKey(record.providerHandleChain.at(-1)!.handle),
          mintedAtFence: child.fence,
          observedAt: HOST_TEST_NOW
        }
      })
    }
    await initial.host.close(HOST_TEST_SESSION, 'evict')
    expect(
      initial.store.getRecord(HOST_TEST_SESSION)?.providerHandleChain.at(-1)?.handle.nativeId
    ).toBe(clears === 'forked-chain' ? CLEARED_THREAD : HOST_TEST_THREAD)
    const f = await clearSource()
    if (clears === 2) {
      await clearSource()
    }
    expect(
      f.db
        .prepare('SELECT 1 FROM conversation_origin_acquisitions WHERE session_id=?')
        .get(HOST_TEST_SESSION)
    ).toBeUndefined()
    const result = await f.host.attach(
      CALLER,
      ensureParams(f.store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence)
    )
    expect(result).toMatchObject({ ok: false })
    expect(
      f.log.entries.some(
        (entry) =>
          entry.fields.error instanceof Error &&
          entry.fields.error.message.includes('cleared native identity')
      )
    ).toBe(true)
    expect(f.store.getRecord(HOST_TEST_SESSION)?.providerHandleChain).toEqual([])
    expect(
      f.db
        .prepare('SELECT 1 FROM conversation_origin_acquisitions WHERE session_id=?')
        .get(HOST_TEST_SESSION)
    ).toBeUndefined()
  }
)

it.each(['missing-proof', 'changed-native'] as const)(
  'rechecks the captured clear identity in the fatal commit: %s',
  async (mode) => {
    await attach()
    const f = hostTestState()
    const prepare = f.store.conversations.clear.prepare.bind(f.store.conversations.clear)
    vi.spyOn(f.store.conversations.clear, 'prepare').mockImplementation(async (...args) => {
      const prepared = await prepare(...args)
      if (mode === 'missing-proof') {
        f.host.deps.journalDatabase.db
          .prepare(
            "UPDATE conversation_clear_intents SET record_json=json_remove(record_json,'$.participants[0].nativeIdentities') WHERE operation_key=?"
          )
          .run(prepared.operationKey)
      } else {
        await f.store.transitionHandoff(HOST_TEST_SESSION, (record) => ({
          ...record,
          providerHandleChain: record.providerHandleChain.map((link) => ({
            ...link,
            handle: codexProviderHandle(CLEARED_THREAD)
          }))
        }))
      }
      return prepared
    })
    await expect(clearSource()).rejects.toThrow('stale-generation')
    const member = f.store.conversations.membership(HOST_TEST_SESSION)!
    expect(f.store.conversations.read(member.conversationId)?.contextGeneration).toBe(1)
    expect(
      f.host.deps.journalDatabase.db
        .prepare('SELECT 1 FROM conversation_clear_rows WHERE session_id=?')
        .get(HOST_TEST_SESSION)
    ).toBeUndefined()
    expect(f.store.getRecord(HOST_TEST_SESSION)?.providerHandleChain).toHaveLength(1)
  }
)

it('distinguishes a captured absent native handle from missing legacy clear proof', async () => {
  const f = await linkedClear()
  const second = await clearSource()
  expect(
    f.store.conversations.clear.intent(second.clear.operationKey)?.participants[0]?.nativeIdentities
  ).toEqual([])
  expect(
    await f.host.attach(
      CALLER,
      ensureParams(f.store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence)
    )
  ).toMatchObject({ ok: true })
  expect(f.store.getRecord(HOST_TEST_SESSION)?.providerHandleChain.at(-1)?.handle.nativeId).toBe(
    CLEARED_THREAD
  )
  const db = f.host.deps.journalDatabase.db
  expect(
    db
      .prepare(
        'SELECT origin_json FROM conversation_origin_acquisitions WHERE session_id=? ORDER BY fence DESC LIMIT 1'
      )
      .get(HOST_TEST_SESSION)?.origin_json
  ).toContain('"contextGeneration":3')
})

it.each([false, true])(
  'checks prior clear identities when a parked participant becomes a candidate (fresh native: %s)',
  async (fresh) => {
    const f = await beginSwitch()
    let conversation = f.store.conversations.read(f.intent.conversationId)!
    await f.store.conversations.cancel({
      operationKey: f.intent.operationKey,
      expectedVersion: f.intent.version,
      expectedRevision: conversation.revision,
      expectedContextGeneration: conversation.contextGeneration,
      expectedActivationFence: conversation.activationFence
    })
    const oldHandle = f.store.getRecord(f.targetId)!.providerHandleChain.at(-1)!.handle
    await clearSource()
    const target = f.store.getRecord(f.targetId)!
    expect(target.providerHandleChain).toEqual([])
    conversation = f.store.conversations.read(f.intent.conversationId)!
    const begun = await f.store.conversations.beginSwitch(
      {
        conversationId: conversation.conversationId,
        expectedRevision: conversation.revision,
        expectedContextGeneration: conversation.contextGeneration,
        expectedActivationFence: conversation.activationFence,
        target,
        expectedNativeBindingGeneration: 2
      },
      {
        callerKey: CALLER.callerKey,
        operationId: hostTestOperationId(),
        fingerprint: 'cleared-target',
        now: HOST_TEST_NOW
      }
    )
    expect(begun.intent?.targetSessionId).toBe(f.targetId)
    const reservation = await f.store.reserveOwner({
      sessionId: f.targetId,
      provider: target.provider,
      location: target.location,
      accountHome: target.accountHome,
      expectedFence: target.lease.runtimeFence,
      spawnToken: 'cleared-candidate-child',
      claimKeyId: 'key-1',
      handoffOperationId: null,
      probe: { outcome: 'pid-absent' },
      operation: {
        callerKey: CALLER.callerKey,
        operationId: hostTestOperationId(),
        fingerprint: 'cleared-target-start'
      },
      now: HOST_TEST_NOW
    })
    const fence = reservation.record.lease.runtimeFence
    await f.store.commitProcessIdentity({
      sessionId: f.targetId,
      fence,
      process: {
        hostId: 'local',
        pid: 4399,
        processStartTimeMs: HOST_TEST_NOW,
        spawnToken: 'cleared-candidate-child'
      },
      now: HOST_TEST_NOW
    })
    const origin = f.store.conversations.captureAcquisitionOrigin(f.targetId)!
    const proving = f.store.proveOwner({
      sessionId: f.targetId,
      fence,
      now: HOST_TEST_NOW,
      conversationOrigin: origin,
      acquisitionGeneration: 'cleared-candidate-acquisition',
      link: {
        linkId: 'reused-candidate-native',
        origin: 'created',
        handle: fresh ? codexProviderHandle(CLEARED_THREAD) : oldHandle,
        mintedAtFence: fence,
        observedAt: HOST_TEST_NOW
      }
    })
    if (fresh) {
      await expect(proving).resolves.toMatchObject({ lease: { claimStatus: 'live' } })
      expect(f.store.getRecord(f.targetId)?.providerHandleChain.at(-1)?.handle.nativeId).toBe(
        CLEARED_THREAD
      )
      return
    }
    await expect(proving).rejects.toThrow('cleared native identity')
    expect(f.store.getRecord(f.targetId)?.providerHandleChain).toEqual([])
    expect(
      f.host.deps.journalDatabase.db
        .prepare('SELECT 1 FROM conversation_origin_acquisitions WHERE session_id=? AND fence=?')
        .get(f.targetId, fence)
    ).toBeUndefined()
  }
)

it('does not erase unknown legacy native history with a later empty clear snapshot', async () => {
  await attach()
  const state = hostTestState()
  await state.host.close(HOST_TEST_SESSION, 'evict')
  const first = await clearSource()
  await clearSource()
  const acquisitions = first.acquire.mock.calls.length
  first.db
    .prepare(
      "UPDATE conversation_clear_intents SET record_json=json_remove(record_json,'$.participants[0].nativeIdentities') WHERE operation_key=?"
    )
    .run(first.clear.operationKey)
  await expect(
    first.host.attach(
      CALLER,
      ensureParams(first.store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence)
    )
  ).rejects.toThrow('cleared native history unknown')
  expect(first.acquire).toHaveBeenCalledTimes(acquisitions)
  expect(first.store.getRecord(HOST_TEST_SESSION)?.providerHandleChain).toEqual([])
})
