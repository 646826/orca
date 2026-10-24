import { afterEach, expect, it, vi } from 'vitest'
import { openAcpAdapterRig, PROVIDER_SESSION } from '../../acp/acp-structured-adapter.test-support'
import { acpLaunchSpecFor } from '../../acp/acp-launch-specs'
import { acpStructuredAgentDefinition } from '../../acp/acp-structured-agent-definitions'
import { StructuredAgentRegistry } from '../agent-session-wire/structured-agent-registry'
import { hostTestState } from '../agent-session-wire/structured-agent-session-host-test-harness'
import { closeProviderTimelineRigs } from '../agent-session-timeline/provider-timeline-assembler-test-support'
import { nativeTriggerFixture } from '../agent-session-wire/structured-conversation-native-trigger.fixture'
import {
  beginSubmissionHandover,
  type AgentSessionHandoverContext
} from '../agent-session-wire/structured-agent-session-handover'
import {
  conversationContextDispatchObserver,
  prepareConversationSubmissionContext
} from '../agent-session-wire/structured-conversation-context-dispatch'
import { AgentSessionPreDispatchError } from '../agent-session-wire/structured-agent-session-operation-settlement'
import { readConversationTransferNoWrite } from './conversation-transfer-no-write'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

async function fixture() {
  const spec = acpLaunchSpecFor('opencode')!
  const events: Parameters<ReturnType<typeof hostTestState>['host']['settleLateDispatch']>[0][] = []
  const rig = await openAcpAdapterRig({
    spec,
    deps: { onDispatchSettledLate: (event) => events.push(event) }
  })
  const host = hostTestState().host
  host.deps.agents = new StructuredAgentRegistry([
    ...host.deps.agents.registrations(),
    { definition: acpStructuredAgentDefinition(spec), adapter: rig.adapter }
  ])
  const f = await nativeTriggerFixture({
    handle: { transport: 'acp', agent: 'opencode', nativeId: PROVIDER_SESSION },
    params: {
      agent: 'opencode',
      provider: 'opencode',
      providerHandle: undefined,
      accountHome: { kind: 'opencode', locator: { kind: 'unmanaged' } }
    }
  })
  f.host.collaboratorsForTests().conversationDelivery.loop.dispose()
  const acquired = await rig.adapter.acquire({ ...f.acquisition, onSpawned: undefined })
  await rig.adapter.open({
    sessionId: f.targetId,
    fence: f.acquisition.fence,
    acquisitionGeneration: acquired.acquisitionGeneration,
    signal: new AbortController().signal
  })
  const context: AgentSessionHandoverContext = {
    requireExactOrigin: true,
    sessionId: f.targetId,
    journal: f.journal,
    adapter: rig.adapter,
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
  const handover = async () => {
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
  let flushed = 0
  const flush = async () => {
    await rig.settle()
    for (const event of events.slice(flushed)) {
      f.settle(event)
    }
    flushed = events.length
    await f.flush()
  }
  const proof = () => readConversationTransferNoWrite(f.db, f.request.transferId)
  const close = async () => {
    await rig.adapter.closeAll()
    await f.host.flushAllStreamedEvents()
    await closeProviderTimelineRigs()
  }
  return { ...f, rig, context, handover, flush, proof, events, close }
}

it('records actual ACP refusal before adapter admission as no user-turn write', async () => {
  const f = await fixture()
  try {
    f.context.beforeDispatch = async () => {
      throw new AgentSessionPreDispatchError('refused before admission')
    }
    await f.handover()
    expect(f.rig.sent('session/prompt')).toEqual([])
    expect(f.journal.submission(f.request.targetSubmissionId)?.dispatchState).toBe('rejected')
    expect(f.proof()).not.toBeNull()
  } finally {
    await f.close()
  }
})

it('keeps a late asynchronous ACP prewrite rejection uncertain rather than deriving proof from rejected', async () => {
  const f = await fixture()
  try {
    f.host.deps.bindConversationEvidencePlan = async () => {
      throw new Error('refused final observation')
    }
    await f.handover()
    await vi.waitFor(async () => {
      await f.flush()
      expect(f.events.some((event) => 'state' in event && event.state === 'rejected')).toBe(true)
    })
    expect(f.rig.sent('session/prompt')).toEqual([])
    expect(f.proof()).toBeNull()
    expect(await f.receipt()).toBeNull()
  } finally {
    await f.close()
  }
})

it('preserves ACP exact acceptance after an already written prompt despite a later aborted signal', async () => {
  const f = await fixture()
  try {
    const stop = new AbortController()
    f.context.acquireAborts = {
      begin: () => ({
        signal: stop.signal,
        abort: () => stop.abort(new Error('Stop')),
        end: () => {}
      })
    }
    await f.handover()
    const frame = await f.rig.frame('session/prompt')
    stop.abort(new Error('Stop after prompt write'))
    f.rig.child().agent.reply(frame, { stopReason: 'end_turn' })
    await vi.waitFor(async () => {
      await f.flush()
      expect(f.journal.submission(f.request.targetSubmissionId)?.dispatchState).toBe('accepted')
    })
    expect(f.rig.sent('session/prompt')).toHaveLength(1)
    expect(f.proof()).toBeNull()
  } finally {
    await f.close()
  }
})
