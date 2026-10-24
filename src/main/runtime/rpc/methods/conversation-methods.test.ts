import { expect, test } from 'vitest'
import { CONVERSATION_METHODS } from './conversation-methods'
import { conversationRpcCaller } from './conversation-method-access'
import { call } from './structured-agent-session-rpc.test-fixture'
test('new surface refuses mixed-version clients before looking up aggregate state', async () => {
  const result = await call(
    'conversation.read',
    { conversationId: 'missing', limit: 128 },
    { clientKind: 'runtime', clientCapabilities: [] },
    {},
    CONVERSATION_METHODS
  )
  expect(result).toHaveProperty('error')
})
test('authenticated caller identity never comes from clientId credential text', () => {
  expect(conversationRpcCaller({ caller: { kind: 'paired-device', deviceId: 'device' } })).toBe(
    'device'
  )
  expect(() => conversationRpcCaller({ clientKind: 'runtime' })).toThrow()
})
