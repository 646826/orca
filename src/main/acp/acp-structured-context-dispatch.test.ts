import { afterEach, expect, it } from 'vitest'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { openAcpAdapterRig, replyChunk } from './acp-structured-adapter.test-support'
afterEach(async () => {
  await closeProviderTimelineRigs()
})
it('observes the exact ACP session/prompt parameters before the write', async () => {
  const rig = await openAcpAdapterRig()
  await rig.acquire()
  const observed: unknown[] = []
  await rig.adapter.dispatch({
    sessionId: SESSION,
    clientMessageId: 'observed',
    fence: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'context' }] },
    beforeContextDispatch: async (value) => {
      observed.push(structuredClone(value))
    }
  })
  const frame = await rig.frame('session/prompt')
  expect(observed).toEqual([{ transport: 'acp', payload: frame.params }])
})
it('rejects a revoked final dispatch without sending a prompt or accepting the turn', async () => {
  const rig = await openAcpAdapterRig()
  await rig.acquire()
  let permitted = true
  await rig.adapter.dispatch({
    sessionId: SESSION,
    clientMessageId: 'revoked',
    fence: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'context' }] },
    beforeContextDispatch: async () => {
      permitted = false
    },
    beforeDispatch: async () => {
      if (!permitted) {
        throw new Error('authority revoked')
      }
    }
  })
  await rig.settle()
  expect(rig.sent('session/prompt')).toEqual([])
  expect(rig.settled).toEqual([expect.objectContaining({ state: 'rejected' })])
})

it('marks acceptance from the exact prompt response as correlated', async () => {
  const rig = await openAcpAdapterRig()
  await rig.acquire()
  await rig.adapter.dispatch({
    sessionId: SESSION,
    clientMessageId: 'response-proof',
    fence: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
  })
  const frame = await rig.frame('session/prompt')
  rig.child().agent.reply(frame, { stopReason: 'end_turn' })
  await rig.settle()
  expect(rig.correlations).toEqual([
    {
      state: 'origin-correlated',
      sessionId: SESSION,
      clientMessageId: 'response-proof',
      fence: 1,
      turnIdentity: {
        provider: 'legacy',
        agent: 'grok',
        sessionId: SESSION,
        recordId: 'turn-lifecycle:p:acp-session-1:prompt%3Aresponse-proof'
      }
    }
  ])
  expect(rig.settled).toEqual([
    expect.objectContaining({ clientMessageId: 'response-proof', originCorrelation: 'exact' })
  ])
})

it('defers strict candidate acceptance until its own prompt response', async () => {
  const rig = await openAcpAdapterRig()
  await rig.acquire()
  await rig.adapter.dispatch({
    sessionId: SESSION,
    clientMessageId: 'strict',
    fence: 1,
    requireExactOrigin: true,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
  })
  const frame = await rig.frame('session/prompt')
  rig.child().agent.notify('session/update', replyChunk('prompt:strict', 'working'))
  await rig.settle()
  expect(rig.settled).toEqual([])
  expect(rig.correlations).toEqual([])
  rig.child().agent.reply(frame, { stopReason: 'end_turn' })
  await rig.settle()
  expect(rig.correlations).toEqual([
    {
      state: 'origin-correlated',
      sessionId: SESSION,
      clientMessageId: 'strict',
      fence: 1,
      turnIdentity: {
        provider: 'legacy',
        agent: 'grok',
        sessionId: SESSION,
        recordId: 'turn-lifecycle:p:acp-session-1:prompt%3Astrict'
      }
    }
  ])
  expect(rig.settled).toEqual([
    expect.objectContaining({ clientMessageId: 'strict', originCorrelation: 'exact' })
  ])
})
