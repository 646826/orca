import { expect, it } from 'vitest'
import { attach, hostTestState } from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION,
  HOST_TEST_NOW,
  hostTestOperationId,
  hostTestAttachParams
} from './structured-agent-session-host-test-data'

it('creates the real empty candidate journal without acquiring a native child or publishing a tab', async () => {
  await attach()
  const { host, store, acquire } = hostTestState()
  const conversation = await host.conversationEnrollment.ensure(HOST_TEST_SESSION)
  const targetId = 'candidate-without-launch'
  const operation = {
    callerKey: 'test',
    operationId: hostTestOperationId(),
    fingerprint: 'candidate',
    now: HOST_TEST_NOW
  }
  const params = hostTestAttachParams(null, { providerHandle: undefined })
  params.envelope = {
    sessionId: targetId,
    clientOperationId: operation.operationId,
    payloadFingerprint: operation.fingerprint,
    expectedRuntimeFence: null
  }
  const calls = acquire.mock.calls.length
  const result = await host.conversationEnrollment.found(
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
  expect(result.intent?.candidateBoundary.endSequence).toBeGreaterThanOrEqual(1)
  expect(store.getRecord(targetId)?.providerHandleChain).toEqual([])
  expect(store.getRecord(targetId)?.lease.claimStatus).toBe('released')
  expect(store.getSessionTabId(targetId)).toBeNull()
  expect(acquire).toHaveBeenCalledTimes(calls)
  expect(store.conversations.read(conversation.conversationId)?.activeSegmentId).toBe(
    conversation.activeSegmentId
  )
})
