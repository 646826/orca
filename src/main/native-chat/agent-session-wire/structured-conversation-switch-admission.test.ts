import { expect, it } from 'vitest'
import { beginSwitch } from './structured-conversation-switch.test-fixture'
import {
  CALLER,
  envelope,
  hostTestState,
  seedApproval
} from './structured-agent-session-host-test-harness'

it('freezes new options while preserving original prompt answers and replay', async () => {
  let prompt!: Awaited<ReturnType<typeof seedApproval>>
  const { host } = await beginSwitch(async () => {
    prompt = await seedApproval()
  })
  const option = await host.setOption(CALLER, {
    envelope: envelope('agentSession.setOption', { key: 'model', value: 'other' }),
    key: 'model',
    value: 'other'
  })
  expect(option).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'conversationSwitchInFlight' } }
  })
  const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId: 'allow' }
  const request = {
    envelope: envelope('agentSession.respondTo:approval', fields),
    kind: 'approval' as const,
    ...fields
  }
  expect(await host.respondToPrompt(CALLER, request)).toMatchObject({ ok: true })
  expect(await host.respondToPrompt(CALLER, request)).toMatchObject({ ok: true, replayed: true })
  expect(hostTestState().answerPrompt).toHaveBeenCalledTimes(1)
})
