import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/electron-remote-runtime-client-capabilities'
import { WEB_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/web-runtime-client-capabilities'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { NATIVE_CONVERSATION_RUNTIME_CAPABILITY } from '../../../../shared/conversation-runtime-capabilities'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  ConversationWatchEventSchema,
  type ConversationInvalidation
} from '../../../../shared/conversation-surface-rpc'
import {
  attach,
  envelope,
  hostTestState
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  hostTestMessage,
  HOST_TEST_SESSION
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { call, dispatcher, STRUCTURED_CLIENT } from './structured-agent-session-rpc.test-fixture'
import { CONVERSATION_METHODS } from './conversation-methods'
import { conversationGateTestRequest } from './conversation-gate.test-fixture'
import { conversationHistoryRevision } from '../../../native-chat/conversations/conversation-history'
import { CONVERSATION_SURFACE_METHODS } from './conversation-surface-methods'
afterEach(() => setStructuredAgentSessionHost(null))
it.each([
  ['desktop', DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES],
  ['paired desktop', ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES],
  ['browser', WEB_RUNTIME_CLIENT_CAPABILITIES]
])(
  'admits the %s handshake to enroll and read an at-rest aggregate without native account identity',
  async (_name, capabilities) => {
    const client = {
      clientKind: 'runtime' as const,
      clientId: 'current-renderer',
      pairedDeviceId: 'authenticated-renderer',
      clientCapabilities: [...capabilities]
    }
    await attach()
    const { host, store } = hostTestState()
    setStructuredAgentSessionHost(host)
    const enrolled = await call(
      'conversation.ensure',
      { sessionId: HOST_TEST_SESSION },
      client,
      {},
      CONVERSATION_METHODS
    )
    expect(enrolled).not.toHaveProperty('error')
    const membership = store.conversations.membership(HOST_TEST_SESSION)!
    const result = await call(
      'conversation.read',
      { conversationId: membership.conversationId },
      client,
      {},
      CONVERSATION_METHODS
    )
    expect(result).not.toHaveProperty('error')
    expect(JSON.stringify(result)).toContain(membership.conversationId)
    expect(JSON.stringify(result)).not.toContain('accountHome')
    expect(JSON.stringify(result)).not.toContain('providerHandle')
    const oversized = await call(
      'conversation.read',
      { conversationId: membership.conversationId, limit: 10000 },
      client,
      {},
      CONVERSATION_METHODS
    )
    expect(oversized).toHaveProperty('error')
  }
)

it('refuses an enrolled record from another WSL distribution even with identical host/workspace IDs', async () => {
  await attach()
  const { host, store } = hostTestState()
  setStructuredAgentSessionHost(host)
  const conversation = await host.conversationEnrollment.ensure(HOST_TEST_SESSION)
  const original = store.getRecord.bind(store)
  vi.spyOn(store, 'getRecord').mockImplementation((id) => {
    const record = original(id)
    return record
      ? { ...record, location: { ...record.location, wslDistro: 'other-distribution' } }
      : record
  })
  const result = await call(
    'conversation.read',
    { conversationId: conversation.conversationId },
    undefined,
    {},
    CONVERSATION_METHODS
  )
  expect(result).toHaveProperty('error')
  expect(result).toMatchObject({
    error: { code: 'conversation_refused', data: { reason: 'scope-mismatch' } }
  })
})

it('rejects old clients and an unauthenticated remote caller before enrollment', async () => {
  await attach()
  const { host, store } = hostTestState()
  setStructuredAgentSessionHost(host)
  const old = await call(
    'conversation.ensure',
    { sessionId: HOST_TEST_SESSION },
    { clientKind: 'runtime', clientCapabilities: [] },
    {},
    CONVERSATION_METHODS
  )
  expect(old).toHaveProperty('error')
  const missing = await call(
    'conversation.ensure',
    { sessionId: HOST_TEST_SESSION },
    {
      clientKind: 'runtime',
      clientCapabilities: [
        STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
        NATIVE_CONVERSATION_RUNTIME_CAPABILITY
      ]
    },
    {},
    CONVERSATION_METHODS
  )
  expect(missing).toHaveProperty('error')
  expect(store.conversations.membership(HOST_TEST_SESSION)).toBeNull()
})

it('admits read-only aggregate clients without permitting enrollment or old-client reads', async () => {
  await attach()
  const { host } = hostTestState()
  setStructuredAgentSessionHost(host)
  const conversation = await host.conversationEnrollment.ensure(HOST_TEST_SESSION)
  const reader = {
    clientId: 'reader',
    clientKind: 'runtime' as const,
    clientCapabilities: [
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
      'agent-session.conversations.read.v1'
    ]
  }
  expect(
    await call(
      'conversation.read',
      { conversationId: conversation.conversationId },
      reader,
      {},
      CONVERSATION_METHODS
    )
  ).not.toHaveProperty('error')
  expect(
    await call(
      'conversation.surfaceRead',
      { conversationId: conversation.conversationId },
      reader,
      {},
      CONVERSATION_SURFACE_METHODS
    )
  ).not.toHaveProperty('error')
  const current = {
    ...reader,
    clientCapabilities: [
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
      NATIVE_CONVERSATION_RUNTIME_CAPABILITY
    ]
  }
  for (const method of ['conversation.read', 'conversation.surfaceRead', 'conversation.history']) {
    const params = {
      conversationId: conversation.conversationId,
      ...(method === 'conversation.history'
        ? {
            segmentId: conversation.activeSegmentId,
            expectedSourceRevision: conversationHistoryRevision(
              host.deps.journalDatabase.db,
              conversation.conversationId,
              conversation.activeSegmentId
            )
          }
        : {})
    }
    const methods =
      method === 'conversation.surfaceRead' ? CONVERSATION_SURFACE_METHODS : CONVERSATION_METHODS
    const legacyRead = await call(method, params, reader, {}, methods)
    expect(legacyRead).not.toHaveProperty('error')
    expect(legacyRead).toEqual(await call(method, params, current, {}, methods))
  }
  const watchedStates: ConversationInvalidation[][] = []
  for (const client of [reader, current]) {
    const controller = new AbortController()
    const states: ConversationInvalidation[] = []
    await dispatcher({}, CONVERSATION_SURFACE_METHODS).dispatchStreaming(
      conversationGateTestRequest('conversation.watch', {
        conversationId: conversation.conversationId
      }),
      (raw) => {
        const reply = z
          .object({ ok: z.literal(true), result: ConversationWatchEventSchema })
          .parse(JSON.parse(raw))
        if (reply.result.type === 'ready') {
          states.push(reply.result.state)
          controller.abort()
        }
      },
      { ...client, signal: controller.signal }
    )
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({
      conversationId: conversation.conversationId,
      revision: conversation.revision,
      activeSegmentId: conversation.activeSegmentId
    })
    watchedStates.push(states)
  }
  expect(watchedStates[0]).toEqual(watchedStates[1])
  for (const method of ['conversation.preparation', 'conversation.preparationEvidence']) {
    expect(
      await call(
        method,
        {
          operationKey: 'read-only-operation',
          ...(method === 'conversation.preparationEvidence'
            ? { manifestDigest: 'a'.repeat(64) }
            : {})
        },
        reader,
        {},
        CONVERSATION_METHODS
      )
    ).toMatchObject({
      error: {
        data: {
          refusal: {
            code: 'structured_agent_session_unsupported',
            details: { reason: 'clientCapabilityMissing' }
          }
        }
      }
    })
  }
  expect(
    await call(
      'conversation.ensure',
      { sessionId: HOST_TEST_SESSION },
      reader,
      {},
      CONVERSATION_METHODS
    )
  ).toHaveProperty('error')
  expect(
    await call(
      'conversation.read',
      { conversationId: conversation.conversationId },
      { ...reader, clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] },
      {},
      CONVERSATION_METHODS
    )
  ).toHaveProperty('error')
})

it('rejects the previous full conversation contract before enrollment without disabling ordinary native chat', async () => {
  await attach()
  const { host, store } = hostTestState()
  setStructuredAgentSessionHost(host)
  const legacy = {
    ...STRUCTURED_CLIENT,
    clientId: 'legacy-conversation-client',
    pairedDeviceId: 'authenticated-legacy-device',
    clientCapabilities: [...STRUCTURED_CLIENT.clientCapabilities, 'agent-session.conversations.v1']
  }
  for (const [method, params] of [
    ['conversation.ensure', { sessionId: HOST_TEST_SESSION }],
    ['conversation.preparation', { operationKey: 'legacy-operation' }]
  ] as const) {
    expect(await call(method, params, legacy, {}, CONVERSATION_METHODS)).toMatchObject({
      error: {
        data: {
          refusal: {
            code: 'structured_agent_session_unsupported',
            details: { reason: 'clientCapabilityMissing' }
          }
        }
      }
    })
    expect(store.conversations.membership(HOST_TEST_SESSION)).toBeNull()
  }
  const body = hostTestMessage('Ordinary native chat still works without aggregate enrollment.')
  const sendEnvelope = envelope('agentSession.send', { body })
  const result = await call('agentSession.send', { envelope: sendEnvelope, body }, legacy)
  expect(result).toMatchObject({
    result: { ok: true, value: { clientMessageId: sendEnvelope.clientOperationId } }
  })
  expect(
    await host.waitForSendSettlement(HOST_TEST_SESSION, sendEnvelope.clientOperationId, {
      budgetMs: 5_000
    })
  ).toMatchObject({ value: { submission: { dispatchState: 'accepted' } } })
  expect(await host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })).toMatchObject({
    ok: true,
    page: { items: expect.arrayContaining([expect.objectContaining({ body })]) }
  })
  expect(store.conversations.membership(HOST_TEST_SESSION)).toBeNull()
})
