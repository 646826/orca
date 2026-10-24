import { expect, test } from 'vitest'
import { CONVERSATION_SURFACE_METHODS } from './conversation-surface-methods'
import { call } from './structured-agent-session-rpc.test-fixture'
import { ConversationSelectAgentParams } from '../../../../shared/conversation-surface-rpc'

test('surface read refuses an old client before host access', async () => {
  const result = await call(
    'conversation.surfaceRead',
    { conversationId: 'missing' },
    { clientKind: 'runtime', clientCapabilities: [] },
    {},
    CONVERSATION_SURFACE_METHODS
  )
  expect(result).toHaveProperty('error')
})
test('agent selection rejects client-authored account or native identity', () => {
  const params = {
    conversationId: 'c',
    expectedRevision: 1,
    expectedContextGeneration: 1,
    expectedActivationFence: 1,
    agent: 'codex',
    nativeSession: 'retain-or-create',
    clientOperationId: `1800000000000-${'1'.repeat(32)}`
  }
  expect(ConversationSelectAgentParams.safeParse(params).success).toBe(true)
  expect(
    ConversationSelectAgentParams.safeParse({ ...params, accountHome: '/account' }).success
  ).toBe(false)
  expect(
    ConversationSelectAgentParams.safeParse({ ...params, nativeHandle: 'thread' }).success
  ).toBe(false)
})
