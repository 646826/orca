import { afterEach, expect, it } from 'vitest'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { openAcpAdapterRig } from './acp-structured-adapter.test-support'

afterEach(closeProviderTimelineRigs)

it('revokes a pending guarded write on Stop, but a later guarded send is not a historical Stop replay', async () => {
  const rig = await openAcpAdapterRig()
  await rig.acquire()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await rig.adapter.dispatch({
    sessionId: SESSION,
    fence: 1,
    clientMessageId: 'stopped-before-write',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'first' }] },
    beforeContextDispatch: async () => {
      entered.resolve()
      await release.promise
    }
  })
  await entered.promise
  expect(await rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })).toEqual({
    cancelled: true
  })
  release.resolve()
  await rig.settle()
  expect(rig.sent('session/prompt')).toEqual([])
  expect(rig.settled).toContainEqual(
    expect.objectContaining({ clientMessageId: 'stopped-before-write', state: 'rejected' })
  )
  await rig.adapter.dispatch({
    sessionId: SESSION,
    fence: 1,
    clientMessageId: 'later-send',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'later' }] },
    beforeContextDispatch: async () => undefined
  })
  const frame = await rig.frame('session/prompt')
  expect(frame.params).toMatchObject({ prompt: [{ type: 'text', text: 'later' }] })
})

it('ordinary adapter dispatch has written its prompt before returning admission', async () => {
  const rig = await openAcpAdapterRig()
  await rig.acquire()
  const result = await rig.adapter.dispatch({
    sessionId: SESSION,
    fence: 1,
    clientMessageId: 'ordinary',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'ordinary' }] }
  })
  expect(result).toEqual({ state: 'admitted' })
  expect(rig.sent('session/prompt')).toHaveLength(1)
})
