import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { expect, it, vi } from 'vitest'
import { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import {
  fakeCodexAppServer,
  echoUserMessage
} from '../../codex/codex-structured-dispatch-test-support'
import {
  hostTestState,
  CALLER,
  envelope,
  attachParams,
  attach
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  HOST_TEST_NOW,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { readConversationNativeIdentity } from '../conversations/conversation-origin-native-identity'

async function startingNative() {
  const f = hostTestState()
  const opened = Promise.withResolvers<{ thread: { id: string } }>()
  const opening = Promise.withResolvers<void>()
  const codex = fakeCodexAppServer({
    'thread/start': () => {
      opening.resolve()
      return opened.promise
    },
    'turn/start': () => ({ turn: { id: 'enrollment-turn' } })
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
    now: () => HOST_TEST_NOW,
    onDispatchSettledLate: (value) => {
      settlements.push(f.host.settleLateDispatch(value))
    }
  })
  f.acquire.mockImplementation((input) => adapter.acquire(input))
  f.host.deps.adapter.open = (input) => adapter.open(input)
  f.dispatch.mockImplementation((input) => adapter.dispatch(input))
  expect(await f.host.attach(CALLER, attachParams({ providerHandle: undefined }))).toMatchObject({
    ok: true
  })
  await opening.promise
  return { ...f, opened, opening, codex, adapter, settlements }
}

it.each(['ready', 'starting', 'send-during-starting'] as const)(
  'enrolls the actual existing native acquisition (provider still starting: %s)',
  async (mode) => {
    const starting = mode !== 'ready'
    const f = await startingNative()
    const { opened, codex, adapter, settlements } = f
    try {
      if (starting) {
        expect(f.store.getRecord(HOST_TEST_SESSION)?.providerHandleChain).toEqual([])
        await f.host.conversationEnrollment.ensure(HOST_TEST_SESSION)
      }
      const body = hostTestMessage('ordinary after source promotion 日本語🙂')
      const request = envelope('agentSession.send', { body })
      const early =
        mode === 'send-during-starting'
          ? await f.host.send(CALLER, { envelope: request, body, userSend: true })
          : null
      if (early) {
        expect(early).toMatchObject({ ok: true })
      }
      opened.resolve({ thread: { id: HOST_TEST_THREAD } })
      await vi.waitFor(() =>
        expect(f.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.child?.phase).toBe(
          'ready'
        )
      )
      if (!starting) {
        await f.host.conversationEnrollment.ensure(HOST_TEST_SESSION)
      }
      const db = f.host.deps.journalDatabase.db
      const fence = f.store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
      expect(
        db
          .prepare(
            'SELECT native_identity FROM conversation_origin_acquisitions WHERE session_id=? AND fence=?'
          )
          .get(HOST_TEST_SESSION, fence)?.native_identity
      ).toBe(readConversationNativeIdentity(db, HOST_TEST_SESSION))
      const sending = early ?? f.host.send(CALLER, { envelope: request, body, userSend: true })
      await vi.waitFor(() =>
        expect(codex.connections[0]?.calls.some((call) => call.method === 'turn/start')).toBe(true)
      )
      const connection = codex.connections[0]!
      connection.handlers.onNotification?.('turn/started', {
        threadId: HOST_TEST_THREAD,
        turn: { id: 'enrollment-turn' }
      })
      echoUserMessage(connection, {
        threadId: HOST_TEST_THREAD,
        turnId: 'enrollment-turn',
        itemId: 'enrollment-user',
        clientId: request.clientOperationId
      })
      expect(await sending).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(settlements.length).toBeGreaterThan(0))
      await Promise.all(settlements)
      connection.handlers.onNotification?.('turn/completed', {
        threadId: HOST_TEST_THREAD,
        turn: { id: 'enrollment-turn', status: 'completed' }
      })
      await f.host.flushStreamedEvents(HOST_TEST_SESSION)
      expect(
        db
          .prepare(
            'SELECT 1 FROM conversation_origin_rows WHERE session_id=? AND origin_json IS NULL'
          )
          .get(HOST_TEST_SESSION)
      ).toBeUndefined()
    } finally {
      opened.resolve({ thread: { id: HOST_TEST_THREAD } })
      await adapter.closeAll()
    }
  }
)

it.each(['missing-child', 'stale-fence', 'rollback'] as const)(
  'does not partially enroll an unsupported starting owner: %s',
  async (mode) => {
    const f = await startingNative()
    try {
      const db = f.host.deps.journalDatabase.db
      const child = f.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.child!
      if (mode === 'rollback') {
        db.exec(
          "CREATE TRIGGER reject_enrollment_pending BEFORE INSERT ON conversation_pending_native_identity BEGIN SELECT RAISE(ABORT,'enrollment durable failure'); END"
        )
      }
      const enrolling =
        mode === 'rollback'
          ? f.host.conversationEnrollment.ensure(HOST_TEST_SESSION)
          : f.store.conversations.ensureSingleton(
              HOST_TEST_SESSION,
              mode === 'missing-child'
                ? undefined
                : { generation: child.generation!, fence: child.fence + 1 }
            )
      await expect(enrolling).rejects.toThrow(
        mode === 'rollback' ? 'enrollment durable failure' : 'current native acquisition'
      )
      expect(f.store.conversations.membership(HOST_TEST_SESSION)).toBeNull()
      expect(
        db
          .prepare('SELECT 1 FROM conversation_origin_enrollments WHERE session_id=?')
          .get(HOST_TEST_SESSION)
      ).toBeUndefined()
      expect(
        db
          .prepare('SELECT 1 FROM conversation_origin_acquisitions WHERE session_id=?')
          .get(HOST_TEST_SESSION)
      ).toBeUndefined()
      expect(
        db
          .prepare('SELECT 1 FROM conversation_pending_native_identity WHERE session_id=?')
          .get(HOST_TEST_SESSION)
      ).toBeUndefined()
    } finally {
      f.opened.resolve({ thread: { id: HOST_TEST_THREAD } })
      await f.adapter.closeAll()
    }
  }
)

it.each(['foreign-generation', 'resumed-handle', 'replaced-child'] as const)(
  'does not publish an enrolled starting identity from %s',
  async (mode) => {
    const f = await startingNative()
    try {
      await f.host.conversationEnrollment.ensure(HOST_TEST_SESSION)
      const db = f.host.deps.journalDatabase.db
      const child = f.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.child!
      if (mode === 'replaced-child') {
        await f.host.close(HOST_TEST_SESSION, 'evict')
      }
      await expect(
        f.store.publishProviderHandle({
          sessionId: HOST_TEST_SESSION,
          fence: child.fence,
          acquisitionGeneration:
            mode === 'foreign-generation' ? 'foreign-acquisition' : child.generation!,
          link: {
            linkId: 'rejected-start-link',
            handle: codexProviderHandle(HOST_TEST_THREAD),
            origin: mode === 'resumed-handle' ? 'resumed' : 'created',
            mintedAtFence: child.fence,
            observedAt: HOST_TEST_NOW
          },
          now: HOST_TEST_NOW
        })
      ).rejects.toThrow(
        mode === 'foreign-generation'
          ? 'acquisition proof changed'
          : mode === 'resumed-handle'
            ? 'agent_session_provider_handle_invalid'
            : 'ownership changed'
      )
      expect(f.store.getRecord(HOST_TEST_SESSION)?.providerHandleChain).toEqual([])
      expect(
        db
          .prepare(
            'SELECT native_identity FROM conversation_origin_acquisitions WHERE session_id=? AND fence=?'
          )
          .get(HOST_TEST_SESSION, child.fence)?.native_identity
      ).toBeNull()
      expect(
        db
          .prepare(
            'SELECT native_identity FROM conversation_pending_native_identity WHERE session_id=? AND fence=?'
          )
          .get(HOST_TEST_SESSION, child.fence)?.native_identity
      ).toBeNull()
    } finally {
      f.opened.resolve({ thread: { id: HOST_TEST_THREAD } })
      await f.adapter.closeAll()
    }
  }
)

it.each(['provider-effect', 'unbound-submission', 'foreign-pending', 'stale-pending'] as const)(
  'keeps pre-publication effects untrusted after ordinary admission: %s',
  async (mode) => {
    const f = await startingNative()
    try {
      await f.host.conversationEnrollment.ensure(HOST_TEST_SESSION)
      const db = f.host.deps.journalDatabase.db
      const fence = f.store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
      if (mode === 'foreign-pending') {
        db.prepare(
          "UPDATE conversation_pending_native_identity SET origin_json=json_set(origin_json,'$.conversationId','foreign') WHERE session_id=?"
        ).run(HOST_TEST_SESSION)
      }
      if (mode === 'stale-pending') {
        db.prepare(
          "UPDATE conversation_pending_native_identity SET origin_json=json_set(origin_json,'$.nativeBindingGeneration',2) WHERE session_id=?"
        ).run(HOST_TEST_SESSION)
      }
      const body = hostTestMessage('admitted before native publication')
      const request = envelope('agentSession.send', { body })
      expect(await f.host.send(CALLER, { envelope: request, body, userSend: true })).toMatchObject({
        ok: true
      })
      if (mode === 'provider-effect') {
        expect(
          db
            .prepare(
              'SELECT effect_seen FROM conversation_pending_native_identity WHERE session_id=?'
            )
            .get(HOST_TEST_SESSION)?.effect_seen
        ).toBe(0)
        f.acquire.mock.calls[0]![0].events!.appendItem(
          {
            provider: 'codex',
            threadId: HOST_TEST_THREAD,
            turnId: 'unexpected-start-turn',
            ordinal: 1
          },
          {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'effect before identity proof' }]
          },
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        await f.host.flushStreamedEvents(HOST_TEST_SESSION)
      }
      if (mode === 'unbound-submission') {
        const journal = f.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
        await journal.appendSubmission({
          clientMessageId: 'unbound-before-open',
          payloadFingerprint: 'unbound-before-open',
          body: hostTestMessage('no admission witness'),
          fence
        })
      }
      expect(
        db
          .prepare(
            'SELECT effect_seen FROM conversation_pending_native_identity WHERE session_id=?'
          )
          .get(HOST_TEST_SESSION)?.effect_seen
      ).toBe(1)
      f.opened.resolve({ thread: { id: HOST_TEST_THREAD } })
      await vi.waitFor(() =>
        expect(
          f.log.entries.some((entry) => entry.fields.scope === 'provider-started-handle')
        ).toBe(true)
      )
      expect(f.store.getRecord(HOST_TEST_SESSION)?.providerHandleChain).toEqual([])
      expect(
        db
          .prepare(
            'SELECT native_identity FROM conversation_origin_acquisitions WHERE session_id=? AND fence=?'
          )
          .get(HOST_TEST_SESSION, fence)?.native_identity
      ).toBeNull()
      expect(f.dispatch).not.toHaveBeenCalled()
    } finally {
      f.opened.resolve({ thread: { id: HOST_TEST_THREAD } })
      await f.adapter.closeAll()
    }
  }
)

it('rolls back both an admitted starting submission and effect taint when its required origin write fails', async () => {
  const f = await startingNative()
  try {
    await f.host.conversationEnrollment.ensure(HOST_TEST_SESSION)
    const db = f.host.deps.journalDatabase.db
    const journal = f.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
    const cursor = journal.cursor()
    db.exec(
      "CREATE TRIGGER reject_start_origin BEFORE INSERT ON conversation_origin_rows BEGIN SELECT RAISE(ABORT,'starting origin unavailable'); END"
    )
    const body = hostTestMessage('rollback startup admission')
    const request = envelope('agentSession.send', { body })
    expect(await f.host.send(CALLER, { envelope: request, body, userSend: true })).toMatchObject({
      ok: false
    })
    expect(journal.cursor()).toEqual(cursor)
    expect(journal.submission(request.clientOperationId)).toBeUndefined()
    expect(
      db
        .prepare(
          "SELECT 1 FROM conversation_origin_bindings WHERE session_id=? AND key_kind='submission' AND key_id=?"
        )
        .get(HOST_TEST_SESSION, request.clientOperationId)
    ).toBeUndefined()
    await expect(
      journal.appendSubmission({
        clientMessageId: 'unbound-rollback',
        payloadFingerprint: 'unbound-rollback',
        body,
        fence: f.store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
      })
    ).rejects.toThrow('starting origin unavailable')
    expect(
      db
        .prepare('SELECT effect_seen FROM conversation_pending_native_identity WHERE session_id=?')
        .get(HOST_TEST_SESSION)?.effect_seen
    ).toBe(0)
    db.exec('DROP TRIGGER reject_start_origin')
    f.opened.resolve({ thread: { id: HOST_TEST_THREAD } })
    await vi.waitFor(() =>
      expect(f.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.child?.phase).toBe(
        'ready'
      )
    )
  } finally {
    f.opened.resolve({ thread: { id: HOST_TEST_THREAD } })
    await f.adapter.closeAll()
  }
})

it('does not enroll between acquisition origin capture and owner proof and permits a ready retry', async () => {
  await attach()
  const f = hostTestState()
  await f.host.close(HOST_TEST_SESSION, 'evict')
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const original = f.acquire.getMockImplementation()!
  f.acquire.mockImplementation(async (input) => {
    entered.resolve()
    await release.promise
    return original(input)
  })
  const body = hostTestMessage('ordinary cold start before enrollment')
  expect(
    await f.host.send(CALLER, {
      envelope: envelope('agentSession.send', { body }),
      body,
      userSend: true
    })
  ).toMatchObject({ ok: true })
  await entered.promise
  try {
    expect(f.store.getRecord(HOST_TEST_SESSION)?.lease.claimStatus).toBe('reserved')
    await expect(f.host.conversationEnrollment.ensure(HOST_TEST_SESSION)).rejects.toThrow('busy')
    expect(f.store.conversations.membership(HOST_TEST_SESSION)).toBeNull()
    expect(
      f.host.deps.journalDatabase.db
        .prepare('SELECT 1 FROM conversation_origin_enrollments WHERE session_id=?')
        .get(HOST_TEST_SESSION)
    ).toBeUndefined()
  } finally {
    release.resolve()
  }
  await vi.waitFor(() =>
    expect(f.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.child?.phase).toBe(
      'ready'
    )
  )
  const conversation = await f.host.conversationEnrollment.ensure(HOST_TEST_SESSION)
  expect(f.store.conversations.membership(HOST_TEST_SESSION)?.conversationId).toBe(
    conversation.conversationId
  )
  const db = f.host.deps.journalDatabase.db
  expect(
    db
      .prepare(
        'SELECT native_identity FROM conversation_origin_acquisitions WHERE session_id=? AND fence=?'
      )
      .get(HOST_TEST_SESSION, f.store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence)
      ?.native_identity
  ).toBe(readConversationNativeIdentity(db, HOST_TEST_SESSION))
})
