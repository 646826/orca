import { expect } from 'vitest'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { AgentSessionProviderHandle } from '../../../shared/agent-session-provider-handle'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import {
  attach,
  replaceHostTestState,
  hostTestState,
  CALLER
} from './structured-agent-session-host-test-harness'
import {
  hostTestAttachParams,
  hostTestOperationId,
  HOST_TEST_NOW,
  HOST_TEST_SESSION
} from './structured-agent-session-host-test-data'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

export async function beginSwitch(
  afterSourceAttach?: () => Promise<void>,
  targetFixture?: { handle: AgentSessionProviderHandle; params: Partial<AgentSessionAttachParams> }
) {
  await attach()
  await afterSourceAttach?.()
  const { host, store, acquire } = hostTestState()
  host.deps.hasOpenDispatch = () => false
  const originalAcquire = acquire.getMockImplementation()
  if (!originalAcquire) {
    throw new Error('missing provider fixture')
  }
  acquire.mockImplementation(async (input) => {
    const acquired = await originalAcquire(input)
    if (!acquired.link) {
      throw new Error('missing acquired link')
    }
    return {
      ...acquired,
      link: {
        ...acquired.link,
        origin: 'created',
        handle: targetFixture?.handle ?? codexProviderHandle('019fd532-7c11-7a90-b6de-4e1a2c3d5f61')
      }
    }
  })
  const targetId = 'switch-target'
  const targetParams = hostTestAttachParams(null, {
    envelope: {
      sessionId: targetId,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: null,
      payloadFingerprint: ''
    },
    providerHandle: { kind: 'codex', threadId: '019fd532-7c11-7a90-b6de-4e1a2c3d5f61' },
    ...targetFixture?.params
  })
  const attached = await host.attach(CALLER, targetParams)
  if (!attached.ok) {
    throw new Error(JSON.stringify(attached))
  }
  const target = store.getRecord(targetId)
  if (!target) {
    throw new Error('missing target')
  }
  const conversation = await store.conversations.ensureSingleton(HOST_TEST_SESSION)
  const begun = await store.conversations.beginSwitch(
    {
      conversationId: conversation.conversationId,
      expectedRevision: conversation.revision,
      expectedContextGeneration: conversation.contextGeneration,
      expectedActivationFence: conversation.activationFence,
      target,
      expectedNativeBindingGeneration: 1
    },
    {
      callerKey: CALLER.callerKey,
      operationId: hostTestOperationId(),
      fingerprint: 'switch',
      now: HOST_TEST_NOW
    }
  )
  if (!begun.intent) {
    throw new Error('missing switch intent')
  }
  return { host, store, targetId, intent: begun.intent }
}

export async function beginFreshSwitch() {
  const state = hostTestState()
  const host = new StructuredAgentSessionHost({
    ...state.host.deps,
    conversationPreparationFactory: () => ({
      preparation: {
        prepare: async () => ({ kind: 'blocked', reasons: ['fixture-preparation'] }),
        readPlan: () => null,
        verifyTrigger: () => {
          throw new Error('unverified fixture preparation')
        }
      },
      readPreparationEvidence: () => null,
      canRetrieve: () => false
    })
  })
  replaceHostTestState({ host, store: state.store })
  await attach()
  host.deps.hasOpenDispatch = () => false
  const targetId = 'fresh-switch-target'
  const originalAcquire = state.acquire.getMockImplementation()!
  state.acquire.mockImplementation(async (input) => {
    if (input.identity.sessionId !== targetId) {
      return originalAcquire(input)
    }
    return {
      acquisitionGeneration: 'fresh-switch-child',
      process: {
        hostId: 'local',
        pid: 4321,
        processStartTimeMs: 1700000000000,
        spawnToken: state.store.getRecord(targetId)!.lease.reservedSpawnToken!
      },
      link: {
        linkId: 'fresh-switch-native',
        handle: codexProviderHandle('019fd532-7c11-7a90-b6de-4e1a2c3d5f61'),
        origin: 'created',
        mintedAtFence: input.fence,
        observedAt: HOST_TEST_NOW
      }
    }
  })
  const conversation = await host.conversationEnrollment.ensure(HOST_TEST_SESSION)
  const operation = {
    callerKey: CALLER.callerKey,
    operationId: hostTestOperationId(),
    fingerprint: 'fresh-switch',
    now: HOST_TEST_NOW
  }
  const params = hostTestAttachParams(null, { providerHandle: undefined })
  params.envelope = {
    sessionId: targetId,
    clientOperationId: operation.operationId,
    payloadFingerprint: operation.fingerprint,
    expectedRuntimeFence: null
  }
  const begun = await host.conversationEnrollment.found(
    {
      conversationId: conversation.conversationId,
      expectedRevision: conversation.revision,
      expectedContextGeneration: conversation.contextGeneration,
      expectedActivationFence: conversation.activationFence,
      expectedNativeBindingGeneration: 1,
      target: {
        sessionId: targetId,
        provider: params.provider,
        location: params.location,
        accountHome: params.accountHome
      }
    },
    operation,
    params,
    {}
  )
  if (!begun.intent) {
    throw new Error('fresh switch missing')
  }
  await expect(
    host.deps.conversationSwitchRuntime!.prepare(begun.intent, null, new AbortController().signal)
  ).resolves.toEqual({
    kind: 'blocked',
    reasons: ['fixture-preparation']
  })
  return { host, store: state.store, targetId, intent: begun.intent }
}
