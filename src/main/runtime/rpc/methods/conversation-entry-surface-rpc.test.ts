import { afterEach, assert, expect, it } from 'vitest'
import {
  attach,
  hostTestState
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredAgentSessionTabId } from '../../../../shared/structured-agent-session-projection'
import { call } from './structured-agent-session-rpc.test-fixture'
import { CONVERSATION_METHODS } from './conversation-methods'

afterEach(() => setStructuredAgentSessionHost(null))

it.each([undefined, 'reserved-source-pane'])(
  'returns opt-in durable source identity without changing legacy enrollment or native records: %s',
  async (reservedTabId) => {
    await attach()
    const { host, store } = hostTestState()
    setStructuredAgentSessionHost(host)
    await store.setSessionTabVisibility(HOST_TEST_SESSION, true, reservedTabId)
    const before = store.getRecord(HOST_TEST_SESSION)
    const legacy = await call(
      'conversation.ensure',
      { sessionId: HOST_TEST_SESSION },
      undefined,
      {},
      CONVERSATION_METHODS
    )
    const withSurface = await call(
      'conversation.ensure',
      {
        sessionId: HOST_TEST_SESSION,
        includeSourceSurface: true
      },
      undefined,
      {},
      CONVERSATION_METHODS
    )
    const conversation = store.conversations.membership(HOST_TEST_SESSION)!
    assert('result' in legacy, 'Legacy enrollment must succeed')
    assert('result' in withSurface, 'Surface-aware enrollment must succeed')
    expect(legacy.result).toEqual(store.conversations.read(conversation.conversationId))
    expect(withSurface).not.toHaveProperty('error')
    expect(withSurface.result).toEqual({
      ...store.conversations.read(conversation.conversationId),
      sourceTabId: reservedTabId ?? structuredAgentSessionTabId(HOST_TEST_SESSION)
    })
    expect(withSurface.result).not.toHaveProperty('accountHome')
    expect(store.getRecord(HOST_TEST_SESSION)).toEqual(before)
    expect(store.conversations.read(conversation.conversationId)).not.toHaveProperty('sourceTabId')
  }
)

it('recovers the same durable source identity after promotion detached its native tab', async () => {
  await attach()
  const { host, store } = hostTestState()
  setStructuredAgentSessionHost(host)
  await store.setSessionTabVisibility(HOST_TEST_SESSION, true, 'durable-source-pane')
  const conversation = await host.conversationEnrollment.ensure(HOST_TEST_SESSION)
  await host.conversationEnrollment.promote(
    {
      conversationId: conversation.conversationId,
      sourceSessionId: HOST_TEST_SESSION,
      expectedTabId: 'durable-source-pane',
      expectedRevision: conversation.revision
    },
    () => {}
  )
  expect(store.getSessionTabId(HOST_TEST_SESSION)).toBeNull()
  const recovered = await call(
    'conversation.ensure',
    {
      sessionId: HOST_TEST_SESSION,
      includeSourceSurface: true
    },
    undefined,
    {},
    CONVERSATION_METHODS
  )
  expect(recovered).not.toHaveProperty('error')
  assert('result' in recovered, 'Promoted source identity must remain readable')
  expect(recovered.result).toMatchObject({
    conversationId: conversation.conversationId,
    sourceTabId: 'durable-source-pane'
  })
})

it('refuses source surface metadata when the native tab is absent instead of deriving an ID', async () => {
  await attach()
  const { host } = hostTestState()
  setStructuredAgentSessionHost(host)
  const result = await call(
    'conversation.ensure',
    {
      sessionId: HOST_TEST_SESSION,
      includeSourceSurface: true
    },
    undefined,
    {},
    CONVERSATION_METHODS
  )
  expect(result).toMatchObject({
    error: { code: 'conversation_refused', data: { reason: 'source-unavailable' } }
  })
})
