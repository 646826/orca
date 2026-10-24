import { afterEach, beforeEach, expect, it } from 'vitest'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import { createConversationEvidenceLaunchGate } from './conversation-evidence-launch-gate'
let f: Awaited<ReturnType<typeof createConversationSwitchFixture>>
beforeEach(async () => {
  f = await createConversationSwitchFixture()
})
afterEach(() => f.close())
it('requires observed launch approval and checks it synchronously before spawn', () => {
  const gate = createConversationEvidenceLaunchGate(f.host.db)
  const launch = {
    sessionId: 'session-b',
    launchFingerprint: 'resolved',
    transport: 'codex-dynamic-tool' as const
  }
  expect(gate.observe(launch).kind).toBe('trust-required')
  const choice = gate.read(f.operationKey)
  gate.approve({ operationKey: f.operationKey, choiceDigest: choice.choiceDigest }, 'client')
  const ready = gate.observe(launch)
  expect(ready.kind).toBe('approved')
  if (ready.kind !== 'approved') {
    throw new Error('missing approval')
  }
  expect(() => ready.assertBeforeSpawn()).not.toThrow()
  expect(gate.observe({ ...launch, launchFingerprint: 'changed' }).kind).toBe('trust-required')
  expect(() => ready.assertBeforeSpawn()).toThrow()
  expect(() =>
    gate.approve({ operationKey: f.operationKey, choiceDigest: choice.choiceDigest }, 'client')
  ).toThrow()
})
it('does not let a cancelled operation launch through late approval', () => {
  const gate = createConversationEvidenceLaunchGate(f.host.db)
  gate.observe({
    sessionId: 'session-b',
    launchFingerprint: 'resolved',
    transport: 'codex-dynamic-tool'
  })
  const choice = gate.read(f.operationKey)
  f.host.db
    .prepare(
      "UPDATE conversation_switch_intents SET record_json=json_set(record_json,'$.phase','cancelled') WHERE operation_key=?"
    )
    .run(f.operationKey)
  expect(() =>
    gate.approve({ operationKey: f.operationKey, choiceDigest: choice.choiceDigest }, 'client')
  ).toThrow()
})
it('captures the candidate before resolution and refuses cancellation instead of becoming ordinary', () => {
  const gate = createConversationEvidenceLaunchGate(f.host.db)
  const signal = new AbortController()
  let prepared = 0
  const captured = gate.capture(
    'session-b',
    signal.signal,
    () => {
      prepared++
      throw new Error('must not prepare')
    },
    f.operationKey
  )
  if (!captured) {
    throw new Error('missing capture')
  }
  signal.abort()
  expect(() =>
    captured.observe({
      launchFingerprint: 'resolved',
      transport: 'codex-dynamic-tool',
      resuming: false
    })
  ).toThrow()
  expect(prepared).toBe(0)
  expect(() => gate.read(f.operationKey)).toThrow()
})
it('does not invoke registration preparation before exact approval', () => {
  const gate = createConversationEvidenceLaunchGate(f.host.db)
  let prepared = 0
  const captured = gate.capture(
    'session-b',
    undefined,
    () => {
      prepared++
      throw new Error('registration reached')
    },
    f.operationKey
  )
  if (!captured) {
    throw new Error('missing capture')
  }
  const launch = {
    launchFingerprint: 'resolved',
    transport: 'codex-dynamic-tool' as const,
    resuming: false
  }
  expect(() => captured.observe(launch)).toThrow('startup trust')
  expect(prepared).toBe(0)
  const choice = gate.read(f.operationKey)
  gate.approve({ operationKey: f.operationKey, choiceDigest: choice.choiceDigest }, 'client')
  expect(() => captured.observe(launch)).toThrow('registration reached')
  expect(prepared).toBe(1)
})
it('refuses a parked participant after cancellation even when capture starts late', () => {
  const gate = createConversationEvidenceLaunchGate(f.host.db)
  f.host.db
    .prepare(
      "UPDATE conversations SET record_json=json_set(record_json,'$.pendingOperationKey',NULL)"
    )
    .run()
  expect(() =>
    gate.capture(
      'session-b',
      undefined,
      () => {
        throw new Error('unexpected registration')
      },
      null
    )
  ).toThrow()
})
