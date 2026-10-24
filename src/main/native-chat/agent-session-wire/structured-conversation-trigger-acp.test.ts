import { expect, it, vi } from 'vitest'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  replyChunk
} from '../../acp/acp-structured-adapter.test-support'
import { acpLaunchSpecFor } from '../../acp/acp-launch-specs'
import { acpStructuredAgentDefinition } from '../../acp/acp-structured-agent-definitions'
import { StructuredAgentRegistry } from './structured-agent-registry'
import { hostTestState } from './structured-agent-session-host-test-harness'
import { closeProviderTimelineRigs } from '../agent-session-timeline/provider-timeline-assembler-test-support'
import { nativeTriggerFixture } from './structured-conversation-native-trigger.fixture'

it.each(['exact', 'foreign', 'lost'] as const)(
  'OpenCode ACP host first-turn acceptance: %s',
  async (mode) => {
    const spec = acpLaunchSpecFor('opencode')!
    const late: Parameters<ReturnType<typeof hostTestState>['host']['settleLateDispatch']>[0][] = []
    const rig = await openAcpAdapterRig({
      spec,
      deps: { onDispatchSettledLate: (event) => late.push(event) }
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
    try {
      const acquired = await rig.adapter.acquire({ ...f.acquisition, onSpawned: undefined })
      await rig.adapter.open({
        sessionId: f.targetId,
        fence: f.acquisition.fence,
        acquisitionGeneration: acquired.acquisitionGeneration,
        signal: new AbortController().signal
      })
      f.dispatch.mockImplementation((input) => rig.adapter.dispatch(input))
      await f.append()
      const frame = await rig.frame('session/prompt')
      // Streaming notifications do not establish acceptance of this particular prompt.
      rig
        .child()
        .agent.notify(
          'session/update',
          replyChunk(
            mode === 'exact' ? `prompt:${f.request.targetSubmissionId}` : 'unrelated-prompt',
            'streamed reply'
          )
        )
      await rig.settle()
      await f.flush()
      expect(await f.receipt()).toBeNull()
      if (mode === 'lost') {
        await rig.adapter.closeAll()
      } else if (mode === 'exact') {
        rig.child().agent.reply(frame, { stopReason: 'end_turn' })
      } else {
        rig.child().agent.reply({ ...frame, id: 'unrelated-request' }, { stopReason: 'end_turn' })
      }
      await rig.settle()
      for (const event of late) {
        f.settle(event)
      }
      await f.flush()
      if (mode === 'exact') {
        await vi.waitFor(async () => {
          await f.flush()
          expect(
            await f.receipt(),
            JSON.stringify({
              receipt: f.journal.receiptFor(f.request.targetSubmissionId),
              unresolved: f.db
                .prepare(
                  'SELECT * FROM conversation_origin_rows WHERE session_id=? AND origin_json IS NULL'
                )
                .all(f.targetId)
            })
          ).not.toBeNull()
        })
        await f.activate()
        expect(f.store.conversations.route(f.targetId).role).toBe('active')
      } else {
        expect(await f.receipt()).toBeNull()
        expect(f.store.conversations.route(f.targetId).role).not.toBe('active')
      }
      expect(rig.sent('session/prompt')).toHaveLength(1)
    } finally {
      await rig.adapter.closeAll()
      await f.host.flushAllStreamedEvents()
      await closeProviderTimelineRigs()
    }
  }
)

it('refuses ACP correlations from another native namespace or prompt', async () => {
  const spec = acpLaunchSpecFor('opencode')!
  const rig = await openAcpAdapterRig({ spec })
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
  try {
    for (const [namespace, prompt] of [
      ['foreign-native', f.request.targetSubmissionId],
      [PROVIDER_SESSION, 'foreign-prompt']
    ]) {
      f.settle({
        state: 'origin-correlated',
        sessionId: f.targetId,
        clientMessageId: f.request.targetSubmissionId,
        fence: f.acquisition.fence,
        turnIdentity: {
          provider: 'legacy',
          agent: 'opencode',
          sessionId: f.targetId,
          recordId: `turn-lifecycle:p:${encodeURIComponent(namespace!)}:prompt%3A${encodeURIComponent(prompt!)}`
        }
      })
    }
    await f.flush()
    expect(
      f.db
        .prepare('SELECT resolved FROM conversation_origin_correlations WHERE session_id=?')
        .all(f.targetId)
    ).toEqual([{ resolved: 0 }, { resolved: 0 }])
    expect(await f.receipt()).toBeNull()
  } finally {
    await rig.adapter.closeAll()
    await f.host.flushAllStreamedEvents()
    await closeProviderTimelineRigs()
  }
})
