import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { NATIVE_CONVERSATION_RUNTIME_CAPABILITY } from '../../../../shared/conversation-runtime-capabilities'
import {
  call,
  clearStructuredHostStub,
  conversationMembership,
  envelope,
  hostCalls,
  installStructuredHostStub,
  sendParams,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

beforeEach(() => {
  installStructuredHostStub()
  for (const name of [
    'queuedMessageSend',
    'queuedMessageDelete',
    'queuedMessagesResume',
    'queuedMessageEditHold'
  ]) {
    hostCalls[name] = vi.fn(async () => ({ ok: true }))
  }
})
afterEach(clearStructuredHostStub)

test.each([
  ['agentSession.send', sendParams(), 'send'],
  ['agentSession.setOption', { envelope: envelope(), key: 'model', value: 'model' }, 'setOption'],
  [
    'agentSession.queuedMessageSend',
    { envelope: envelope(), messageId: 'draft' },
    'queuedMessageSend'
  ],
  [
    'agentSession.queuedMessageDelete',
    { envelope: envelope(), messageId: 'draft' },
    'queuedMessageDelete'
  ],
  ['agentSession.queuedMessagesResume', { envelope: envelope() }, 'queuedMessagesResume'],
  [
    'agentSession.rewind',
    { envelope: envelope(), itemId: 'item', expectedEpoch: 'epoch' },
    'rewind'
  ],
  ['agentSession.close', { sessionId: SESSION }, 'close']
])(
  'passes trusted negotiation to receipt admission for %s; close has no receipt replay',
  async (method, params, effect) => {
    conversationMembership.mockReturnValue({ conversationId: 'conversation' })
    const result = await call(method, params, STRUCTURED_CLIENT)
    if (effect === 'close') {
      expect(result).toMatchObject({
        error: { message: expect.stringContaining('structured_agent_session_unsupported') }
      })
      expect(hostCalls[effect]).not.toHaveBeenCalled()
      expect(hostCalls.setSessionTabVisibility).not.toHaveBeenCalled()
    } else {
      expect(hostCalls[effect]).toHaveBeenCalledWith(
        expect.objectContaining({ conversationMutationSupported: false }),
        expect.anything()
      )
    }
  }
)

test('negotiated aggregate client and unbound legacy client retain normal send routing', async () => {
  expect(await call('agentSession.send', sendParams(), STRUCTURED_CLIENT)).toHaveProperty('result')
  conversationMembership.mockReturnValue({ conversationId: 'conversation' })
  expect(
    await call('agentSession.send', sendParams(), {
      ...STRUCTURED_CLIENT,
      clientCapabilities: [
        ...STRUCTURED_CLIENT.clientCapabilities,
        NATIVE_CONVERSATION_RUNTIME_CAPABILITY
      ]
    })
  ).toHaveProperty('result')
  expect(hostCalls.send).toHaveBeenCalledTimes(2)
})

test('aggregate membership does not strand original cancel control', async () => {
  conversationMembership.mockReturnValue({ conversationId: 'conversation' })
  expect(
    await call('agentSession.cancel', { envelope: envelope() }, STRUCTURED_CLIENT)
  ).toHaveProperty('result')
  expect(hostCalls.cancel).toHaveBeenCalledOnce()
})

test('legacy aggregate client can settle original approval and release an edit lease', async () => {
  conversationMembership.mockReturnValue({ conversationId: 'conversation' })
  expect(
    await call(
      'agentSession.respondToApproval',
      { envelope: envelope(), itemId: 'approval', expectedRevision: 1, optionId: 'allow' },
      STRUCTURED_CLIENT
    )
  ).toHaveProperty('result')
  expect(hostCalls.respondToPrompt).toHaveBeenCalledOnce()
  expect(
    await call(
      'agentSession.queuedMessageEditHold',
      { sessionId: SESSION, messageId: 'draft', editId: 'edit', action: 'release' },
      STRUCTURED_CLIENT
    )
  ).toHaveProperty('result')
  expect(hostCalls.queuedMessageEditHold).toHaveBeenCalledOnce()
})

test('legacy persistent workspace sleep is blocked while Stop remains available', async () => {
  conversationMembership.mockReturnValue({ conversationId: 'conversation' })
  expect(
    (
      await call(
        'agentSession.sleepWorkspace',
        { workspaceId: 'workspace-1', markAsleep: true },
        STRUCTURED_CLIENT
      )
    ).ok
  ).toBe(false)
  expect(hostCalls.sleepWorkspace).not.toHaveBeenCalled()
  expect(
    (await call('agentSession.sleepWorkspace', { workspaceId: 'workspace-1' }, STRUCTURED_CLIENT))
      .ok
  ).toBe(true)
  expect(hostCalls.sleepWorkspace).toHaveBeenCalledOnce()
})

test('read-only aggregate capability does not admit native mutation or close', async () => {
  conversationMembership.mockReturnValue({ conversationId: 'conversation' })
  const reader = {
    ...STRUCTURED_CLIENT,
    clientCapabilities: [
      ...STRUCTURED_CLIENT.clientCapabilities,
      'agent-session.conversations.read.v1'
    ]
  }
  await call('agentSession.send', sendParams(), reader)
  expect(hostCalls.send).toHaveBeenCalledWith(
    expect.objectContaining({ conversationMutationSupported: false }),
    expect.anything()
  )
  expect(await call('agentSession.close', { sessionId: SESSION }, reader)).toHaveProperty('error')
  expect(hostCalls.close).not.toHaveBeenCalled()
})

test('clears durable tab visibility when closing through the agent-session RPC', async () => {
  const response = await call('agentSession.close', { sessionId: SESSION }, STRUCTURED_CLIENT)

  expect(response).toMatchObject({ ok: true, result: { ok: true } })
  expect(hostCalls.close).toHaveBeenCalledWith(SESSION, 'user-close')
  expect(hostCalls.setSessionTabVisibility).toHaveBeenCalledWith(SESSION, false, undefined, {
    assertMutationSupported: expect.any(Function)
  })
  expect(hostCalls.setSessionTabVisibility.mock.invocationCallOrder[0]).toBeLessThan(
    hostCalls.close.mock.invocationCallOrder[0]!
  )
})

test('rechecks conversation admission inside durable tab retirement before stopping the provider', async () => {
  hostCalls.setSessionTabVisibility.mockImplementationOnce(
    async (
      _sessionId: string,
      _visible: boolean,
      _revision: undefined,
      options: { assertMutationSupported: () => void }
    ) => {
      conversationMembership.mockReturnValue({ conversationId: 'newly-enrolled' })
      options.assertMutationSupported()
    }
  )

  const response = await call('agentSession.close', { sessionId: SESSION }, STRUCTURED_CLIENT)

  expect(response).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('structured_agent_session_unsupported') }
  })
  expect(hostCalls.setSessionTabVisibility).toHaveBeenCalledOnce()
  expect(hostCalls.close).not.toHaveBeenCalled()
})
