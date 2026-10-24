import { afterEach, expect, it, vi } from 'vitest'
import { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import {
  fakeCodexAppServer,
  refuseUnroutedSteer,
  echoUserMessage
} from '../../codex/codex-structured-dispatch-test-support'
import { acquireReadyCodexForTest } from '../../codex/codex-structured-session-adapter-fixture'
import { nativeTriggerFixture } from '../agent-session-wire/structured-conversation-native-trigger.fixture'
import { readConversationTransferNoWrite } from './conversation-transfer-no-write'
import {
  beginSubmissionHandover,
  type AgentSessionHandoverContext
} from '../agent-session-wire/structured-agent-session-handover'
import {
  conversationContextDispatchObserver,
  prepareConversationSubmissionContext
} from '../agent-session-wire/structured-conversation-context-dispatch'
import { AgentSessionPreDispatchError } from '../agent-session-wire/structured-agent-session-operation-settlement'

const close: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of close.splice(0).toReversed()) {
    await cleanup()
  }
})

async function fixture() {
  const f = await nativeTriggerFixture(undefined)
  f.host.collaboratorsForTests().conversationDelivery.loop.dispose()
  const codex = fakeCodexAppServer({
    'thread/start': () => ({ thread: { id: f.plan.nativeSessionId } }),
    'thread/resume': () => ({ thread: { id: f.plan.nativeSessionId } })
  })
  const adapter = new CodexStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: null,
      resumeThreadId: null
    }),
    openConnection: codex.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    onDispatchSettledLate: f.settle
  })
  close.push(() => adapter.closeAll())
  await acquireReadyCodexForTest(adapter, { ...f.acquisition, onSpawned: undefined })
  f.dispatch.mockImplementation((input) => adapter.dispatch(input))
  const connection = codex.connections[0]!
  const proof = () => readConversationTransferNoWrite(f.db, f.request.transferId)
  const abort = () =>
    f.host.collaboratorsForTests().runtimeState.acquireAborts.abort(f.targetId, new Error('Stop'))
  const context: AgentSessionHandoverContext = {
    requireExactOrigin: true,
    sessionId: f.targetId,
    journal: f.journal,
    adapter,
    fence: f.acquisition.fence,
    agents: f.host.deps.agents,
    record: () => f.store.getRecord(f.targetId),
    childWork: () => [],
    childWorkOpen: () => false,
    now: () => 100,
    acquireAborts: f.host.collaboratorsForTests().runtimeState.acquireAborts,
    beforeContextDispatch: conversationContextDispatchObserver(
      f.host.deps,
      f.targetId,
      f.request.targetSubmissionId
    ),
    prepareContextDispatch: (signal) =>
      prepareConversationSubmissionContext(
        f.host.deps,
        f.targetId,
        f.request.targetSubmissionId,
        signal
      )
  }
  const append = async () => {
    await f.append()
    const pending = await beginSubmissionHandover(
      context,
      f.journal.submission(f.request.targetSubmissionId)!,
      () => true
    )
    if (!pending) {
      throw new Error('missing handover')
    }
    try {
      await (
        await pending.dispatch()
      )()
    } finally {
      pending.release?.()
    }
  }
  const settleRejected = async () => {
    await append()
    await vi.waitFor(() =>
      expect(
        f.journal.submission(f.request.targetSubmissionId)?.dispatchState,
        JSON.stringify({ calls: connection.calls, dispatched: f.dispatch.mock.calls.length })
      ).toBe('rejected')
    )
    await f.flush()
  }
  return { ...f, codex, connection, proof, abort, settleRejected, append, context }
}

it('records actual Codex refusal at its first native observation as no user-turn write', async () => {
  const f = await fixture()
  f.host.deps.bindConversationEvidencePlan = async () => {
    throw new Error('context refused')
  }
  await f.settleRejected()
  expect(
    f.connection.calls.filter(
      (call) => call.method === 'turn/start' || call.method === 'turn/steer'
    )
  ).toEqual([])
  expect(f.proof()).not.toBeNull()
})

it.each(['abort', 'second-observer-refusal'] as const)(
  'does not prove no-write after a refused steer and %s',
  async (mode) => {
    const f = await fixture()
    f.connection.handlers.onNotification?.('turn/started', {
      threadId: f.plan.nativeSessionId,
      turn: { id: 'running' }
    })
    f.codex.routes['turn/steer'] = () => {
      if (mode === 'abort') {
        f.abort()
      }
      return refuseUnroutedSteer(undefined)
    }
    await f.settleRejected()
    expect(f.connection.calls.filter((call) => call.method === 'turn/steer')).toHaveLength(1)
    expect(f.connection.calls.filter((call) => call.method === 'turn/start')).toHaveLength(0)
    expect(f.proof()).toBeNull()
  }
)

it('preserves actual Codex admission and later exact acceptance after Stop races the written request', async () => {
  const f = await fixture()
  f.codex.routes['turn/start'] = () => {
    f.abort()
    return { turn: { id: 'written' } }
  }
  await f.append()
  await vi.waitFor(() =>
    expect(f.connection.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1)
  )
  f.connection.handlers.onNotification?.('turn/started', {
    threadId: f.plan.nativeSessionId,
    turn: { id: 'written' }
  })
  echoUserMessage(f.connection, {
    threadId: f.plan.nativeSessionId,
    turnId: 'written',
    itemId: 'exact-written',
    clientId: f.request.targetSubmissionId
  })
  await vi.waitFor(async () => {
    await f.flush()
    expect(f.journal.submission(f.request.targetSubmissionId)?.dispatchState).toBe('accepted')
  })
  expect(f.proof()).toBeNull()
})

it('does not infer prewrite proof from an adapter exception when its native observer is absent', async () => {
  const f = await fixture()
  f.context.beforeContextDispatch = undefined
  f.context.beforeDispatch = async () => {
    throw new AgentSessionPreDispatchError('pre-dispatch-refused')
  }
  await f.settleRejected()
  expect(
    f.connection.calls.filter(
      (call) => call.method === 'turn/start' || call.method === 'turn/steer'
    )
  ).toEqual([])
  expect(f.proof()).toBeNull()
})

it('can prove an explicit host preflight refusal before invoking even an observerless adapter', async () => {
  const f = await fixture()
  f.context.beforeContextDispatch = undefined
  f.context.prepareContextDispatch = async () => {
    throw new AgentSessionPreDispatchError('preflight-refused')
  }
  await f.settleRejected()
  expect(
    f.connection.calls.filter(
      (call) => call.method === 'turn/start' || call.method === 'turn/steer'
    )
  ).toEqual([])
  expect(f.proof()).not.toBeNull()
})

it('does not let a later preflight refusal erase an earlier pending native write for the same submission', async () => {
  const f = await fixture()
  f.codex.routes['turn/start'] = () => ({ turn: { id: 'earlier-written' } })
  await f.append()
  expect(f.connection.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1)
  expect(f.journal.submission(f.request.targetSubmissionId)?.dispatchState).toBe('pending')
  f.context.prepareContextDispatch = async () => {
    throw new AgentSessionPreDispatchError('later-preflight-refused')
  }
  await f.settleRejected()
  expect(f.connection.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1)
  expect(f.proof()).toBeNull()
  expect(f.source.queuedMessages.get(f.request.messageId)?.state).toBe('withdrawn')
})

it('rechecks duplicate pending attempts at rejection commit when another native call interleaves after capture', async () => {
  const f = await fixture()
  const prepare = f.context.prepareContextDispatch
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const entered = vi.fn()
  f.context.prepareContextDispatch = async () => {
    entered()
    await gate
    throw new AgentSessionPreDispatchError('first-preflight-refused')
  }
  const first = f.append()
  await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
  f.context.prepareContextDispatch = prepare
  f.codex.routes['turn/start'] = () => ({ turn: { id: 'interleaved-written' } })
  try {
    await f.append()
  } finally {
    release()
    await first
  }
  expect(f.connection.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1)
  expect(f.journal.submission(f.request.targetSubmissionId)?.dispatchState).toBe('rejected')
  expect(f.proof()).toBeNull()
  expect(f.source.queuedMessages.get(f.request.messageId)?.state).toBe('withdrawn')
})
