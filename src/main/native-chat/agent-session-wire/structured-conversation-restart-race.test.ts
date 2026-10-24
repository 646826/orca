import { expect, it, vi } from 'vitest'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import { interruptedRestart } from './structured-agent-session-restart-interruption-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW as NOW
} from './structured-agent-session-host-test-data'
import { latestNativeChatOrcaStopCut } from '../../../shared/native-chat-orca-stop-cut'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'

it('rechecks interrupted continuation after awaiting the offer read', async () => {
  const { host, dispatch } = await interruptedRestart()
  const snapshot = await host.journalSnapshot(SESSION)
  const cut = latestNativeChatOrcaStopCut(snapshot.items, [])!
  const reading = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const list = AgentSessionRecoveryCapsule.prototype.list
  vi.spyOn(AgentSessionRecoveryCapsule.prototype, 'list').mockImplementationOnce(async function (
    this: AgentSessionRecoveryCapsule,
    ...args
  ) {
    reading.resolve()
    await release.promise
    return list.apply(this, args)
  })
  const pending = host.restartResume.continueInterrupted(SESSION, cut.turnItemId, {
    conversationMutationSupported: false,
    assertMutationSupported: (sessionId: string) => {
      if (host.deps.store.conversations.membership(sessionId)) {
        throw agentSessionRefusalError('structured_agent_session_unsupported', {
          reason: 'clientCapabilityMissing'
        })
      }
    }
  })
  const rejected = expect(pending).rejects.toMatchObject({
    refusal: { details: { reason: 'clientCapabilityMissing' } }
  })
  await reading.promise
  await host.deps.store.conversations.ensureSingleton(SESSION)
  release.resolve()
  await rejected
  expect(dispatch).not.toHaveBeenCalled()
})

it('checks restart reservation inside the actual recovery capsule transaction', async () => {
  const { root } = await interruptedRestart()
  const capsule = new AgentSessionRecoveryCapsule(root)
  const before = await capsule.list(NOW)
  expect(before).toHaveLength(1)
  await expect(
    capsule.beginResume([SESSION], 'legacy-resume', NOW, () => {
      throw new Error('new aggregate refuses legacy reservation')
    })
  ).rejects.toThrow('new aggregate refuses legacy reservation')
  expect(await capsule.list(NOW)).toEqual(before)
})

it('rechecks dismissal under the capsule lock after a participant becomes an aggregate', async () => {
  const { host, root } = await interruptedRestart()
  const clearing = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const dismiss = AgentSessionRecoveryCapsule.prototype.dismiss
  vi.spyOn(AgentSessionRecoveryCapsule.prototype, 'dismiss').mockImplementationOnce(async function (
    this: AgentSessionRecoveryCapsule,
    ...args
  ) {
    clearing.resolve()
    await release.promise
    return dismiss.apply(this, args)
  })
  const pending = host.restartResume.dismiss(
    [SESSION],
    () => true,
    (sessionId) => {
      if (host.deps.store.conversations.membership(sessionId)) {
        throw agentSessionRefusalError('structured_agent_session_unsupported', {
          reason: 'clientCapabilityMissing'
        })
      }
    }
  )
  const rejected = expect(pending).rejects.toMatchObject({
    refusal: { details: { reason: 'clientCapabilityMissing' } }
  })
  await clearing.promise
  await host.deps.store.conversations.ensureSingleton(SESSION)
  release.resolve()
  await rejected
  expect(await new AgentSessionRecoveryCapsule(root).list(NOW)).toHaveLength(1)
})
