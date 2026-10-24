import { afterEach, expect, it, vi } from 'vitest'
import {
  attach,
  hostTestState
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION,
  HOST_TEST_NOW,
  hostTestOperationId
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { call } from './structured-agent-session-rpc.test-fixture'
import { CONVERSATION_METHODS } from './conversation-methods'
afterEach(() => setStructuredAgentSessionHost(null))
it('admits clear on the authenticated aggregate path and exposes only public operation metadata', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(HOST_TEST_NOW)
  await attach()
  const { host, store } = hostTestState()
  setStructuredAgentSessionHost(host)
  const conversation = await store.conversations.ensureSingleton(HOST_TEST_SESSION)
  const params = {
    conversationId: conversation.conversationId,
    expectedRevision: conversation.revision,
    expectedContextGeneration: conversation.contextGeneration,
    expectedActivationFence: conversation.activationFence,
    clientOperationId: hostTestOperationId()
  }
  const result = await call('conversation.clear', params, undefined, {}, CONVERSATION_METHODS)
  expect(result).not.toHaveProperty('error')
  expect(JSON.stringify(result)).toContain('quiescing')
  expect(JSON.stringify(result)).not.toContain('recordBirthDigest')
  expect(JSON.stringify(result)).not.toContain('accountHome')
  expect(store.conversations.read(conversation.conversationId)?.pendingOperationKey).not.toBeNull()
})
it('rejects a client without aggregate capability before acquiring a clear lease', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(HOST_TEST_NOW)
  await attach()
  const { host, store } = hostTestState()
  setStructuredAgentSessionHost(host)
  const conversation = await store.conversations.ensureSingleton(HOST_TEST_SESSION)
  const result = await call(
    'conversation.clear',
    {
      conversationId: conversation.conversationId,
      expectedRevision: conversation.revision,
      expectedContextGeneration: conversation.contextGeneration,
      expectedActivationFence: conversation.activationFence,
      clientOperationId: hostTestOperationId()
    },
    { clientKind: 'runtime', clientCapabilities: [] },
    {},
    CONVERSATION_METHODS
  )
  expect(result).toHaveProperty('error')
  expect(store.conversations.read(conversation.conversationId)?.pendingOperationKey).toBeNull()
})
