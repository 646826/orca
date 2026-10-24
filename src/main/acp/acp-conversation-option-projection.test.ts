import { afterEach, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { SESSION } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { conversationPreparationModel } from '../runtime/structured-conversation-preparation-factory'
import { acpLaunchSpecFor } from './acp-launch-specs'
import {
  openAcpAdapterRig,
  type AcpAdapterRig,
  PROVIDER_SESSION
} from './acp-structured-adapter.test-support'

const MODEL = 'provider/model-a'
const configuration = (model = MODEL) => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: model,
    options: [
      { value: MODEL, name: 'Model A' },
      { value: 'provider/model-b', name: 'Model B' }
    ]
  },
  {
    id: 'reasoning_effort',
    name: 'Effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [{ value: 'high', name: 'High' }]
  }
]
const rigs: AcpAdapterRig[] = []
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.adapter.closeAll()))
})
async function fixture(
  options: { absentModel?: boolean; holdWrites?: boolean; timeoutMs?: number } = {}
) {
  const rig = await openAcpAdapterRig({
    spec: acpLaunchSpecFor('opencode')!,
    deps: { optionWriteTimeoutMs: options.timeoutMs ?? 5000 },
    script: (peer) => {
      peer.on('session/new', (frame) =>
        peer.reply(frame, {
          sessionId: PROVIDER_SESSION,
          configOptions: options.absentModel ? [] : configuration()
        })
      )
      if (options.holdWrites) {
        peer.on('session/set_config_option', () => {})
      }
    }
  })
  rigs.push(rig)
  const adapter: StructuredAgentSessionAdapter = rig.adapter
  return { rig, project: (model = MODEL) => adapter.projectOptions?.(SESSION, { model }) }
}

it('projects only current provider-observed model and effort without native prompts', async () => {
  const f = await fixture()
  await f.rig.acquire()
  expect(f.rig.openFailure()).toBeUndefined()
  expect(f.project()).toMatchObject({ options: { model: MODEL, effort: 'high' } })
  expect(conversationPreparationModel(MODEL, f.project()?.options)).toBe(MODEL)
  expect(f.rig.sent('session/prompt')).toHaveLength(0)
})
it('never converts requested unknown models or default aliases into provider authority', async () => {
  const f = await fixture()
  await f.rig.acquire()
  for (const requested of ['unknown', 'default', 'model-a']) {
    expect(f.project(requested)).toBeUndefined()
    expect(conversationPreparationModel(requested, f.project(requested)?.options)).toBeNull()
  }
})
it('refuses missing model observations despite an explicit requested model', async () => {
  const f = await fixture({ absentModel: true })
  await f.rig.acquire()
  expect(f.project()).toBeUndefined()
  expect(f.project()?.options.model).toBeUndefined()
  expect(conversationPreparationModel(MODEL, f.project()?.options)).toBeNull()
})
it('retires model and effort proof during a write and projects the actual returned model', async () => {
  const f = await fixture({ holdWrites: true })
  await f.rig.acquire()
  expect(f.project()?.options.model).toBe(MODEL)
  const writing = f.rig.adapter.setOption({
    sessionId: SESSION,
    fence: 1,
    key: 'model',
    value: 'provider/model-b'
  })
  const frame = await f.rig.frame('session/set_config_option')
  expect(f.project()?.options.model).toBeUndefined()
  expect(f.project()?.options.effort).toBeUndefined()
  f.rig.child().agent.reply(frame, { configOptions: configuration(MODEL) })
  await writing
  expect(f.project()).toBeUndefined()
  expect(conversationPreparationModel('provider/model-b', f.project()?.options)).toBeNull()
})
it('does not restore timed-out proof from a late successful response', async () => {
  const f = await fixture({ holdWrites: true, timeoutMs: 20 })
  await f.rig.acquire()
  expect(f.project()?.options.model).toBe(MODEL)
  await expect(
    f.rig.adapter.setOption({
      sessionId: SESSION,
      fence: 1,
      key: 'model',
      value: 'provider/model-b'
    })
  ).rejects.toThrow()
  f.rig.child().agent.reply(f.rig.sent('session/set_config_option')[0]!, {
    configOptions: configuration('provider/model-b')
  })
  await f.rig.settle()
  expect(f.project()?.options.model).toBeUndefined()
})
it('refuses missing, starting and closed native children', async () => {
  const f = await fixture()
  expect(f.project()).toBeUndefined()
  await f.rig.acquire({ waitForStart: false })
  expect(f.project()).toBeUndefined()
  await f.rig.adapter.open({
    sessionId: SESSION,
    fence: 1,
    acquisitionGeneration: 'gen-acp',
    signal: new AbortController().signal
  })
  await vi.waitFor(() => expect(f.project()?.options.model).toBe(MODEL))
  await f.rig.adapter.closeAll()
  expect(f.project()).toBeUndefined()
})

it('does not let a superseded response replace newer proven execution choices', async () => {
  const f = await fixture({ holdWrites: true })
  await f.rig.acquire()
  expect(f.project()?.options.model).toBe(MODEL)
  const first = f.rig.adapter.setOption({
    sessionId: SESSION,
    fence: 1,
    key: 'model',
    value: MODEL
  })
  const firstRejected = expect(first).rejects.toThrow('superseded')
  const second = f.rig.adapter.setOption({
    sessionId: SESSION,
    fence: 1,
    key: 'model',
    value: 'provider/model-b'
  })
  const frame = await f.rig.frame('session/set_config_option', 1)
  f.rig.child().agent.reply(frame, { configOptions: configuration('provider/model-b') })
  await second
  f.rig
    .child()
    .agent.reply(f.rig.sent('session/set_config_option')[0]!, { configOptions: configuration() })
  await firstRejected
  expect((await f.rig.adapter.readOptions({ sessionId: SESSION, fence: 1 })).current.model).toBe(
    'provider/model-b'
  )
  expect(f.project('provider/model-b')?.options).toEqual({ model: 'provider/model-b' })
  await expect(
    f.rig.adapter.setOption({ sessionId: SESSION, fence: 1, key: 'unsupported', value: 'x' })
  ).rejects.toThrow('no session option')
  expect((await f.rig.adapter.readOptions({ sessionId: SESSION, fence: 1 })).current.model).toBe(
    'provider/model-b'
  )
  expect(f.project('provider/model-b')?.options).toEqual({ model: 'provider/model-b' })
})

it('preserves ready-only provider slash-command reads alongside the projection', async () => {
  const f = await fixture()
  expect(f.rig.adapter.readCommands(SESSION)).toBeUndefined()
  await f.rig.acquire()
  f.rig.child().agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'inspect', description: 'Read the project' }]
    }
  })
  await f.rig.settle()
  expect(f.rig.adapter.readCommands(SESSION)).toEqual([
    { name: 'inspect', kind: 'command', description: 'Read the project' }
  ])
  await f.rig.adapter.closeAll()
  expect(f.rig.adapter.readCommands(SESSION)).toBeUndefined()
})

it('refuses preparation before a hidden default-effort restoration would mutate native options', async () => {
  const f = await fixture({ holdWrites: true })
  await f.rig.acquire()
  expect(f.project()).toBeDefined()
  const writing = f.rig.adapter.setOption({
    sessionId: SESSION,
    fence: 1,
    key: 'model',
    value: MODEL
  })
  f.rig
    .child()
    .agent.reply(await f.rig.frame('session/set_config_option'), { configOptions: configuration() })
  await writing
  const writes = f.rig.sent('session/set_config_option').length
  expect(f.project()).toBeUndefined()
  expect(conversationPreparationModel(MODEL, f.project()?.options)).toBeNull()
  expect(f.rig.sent('session/set_config_option')).toHaveLength(writes)
  expect(f.rig.sent('session/prompt')).toHaveLength(0)
})
