import { expect, test, vi } from 'vitest'
import {
  attach,
  hostTestState
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { CONVERSATION_SURFACE_METHODS } from './conversation-surface-methods'
import { call } from './structured-agent-session-rpc.test-fixture'

test('closing a conversation surface publishes visibility without retiring its native participant', async () => {
  await attach()
  const { host, store } = hostTestState()
  await store.setSessionTabVisibility(HOST_TEST_SESSION, true, 'visual-conversation')
  const conversation = await host.conversationEnrollment.ensure(HOST_TEST_SESSION)
  const surface = await host.conversationEnrollment.promote(
    {
      conversationId: conversation.conversationId,
      sourceSessionId: HOST_TEST_SESSION,
      expectedTabId: 'visual-conversation',
      expectedRevision: conversation.revision
    },
    () => undefined
  )
  const before = store.getRecord(HOST_TEST_SESSION)
  const publish = vi.fn(async () => undefined)
  const runtime = {
    ensureStructuredAgentSessionHost: async () => {
      setStructuredAgentSessionHost(host)
      return host
    },
    publishConversationSurfaces: publish
  }
  try {
    const params = {
      conversationId: conversation.conversationId,
      expectedSurfaceRevision: surface.surfaceRevision,
      visible: false
    }
    const result = await call(
      'conversation.setSurfaceVisibility',
      params,
      undefined,
      runtime,
      CONVERSATION_SURFACE_METHODS
    )
    expect(result).not.toHaveProperty('error')
    expect(store.conversations.surfaces.read(conversation.conversationId)?.visible).toBe(false)
    expect(store.getRecord(HOST_TEST_SESSION)).toEqual(before)
    expect(publish).toHaveBeenCalledTimes(1)
    const stale = await call(
      'conversation.setSurfaceVisibility',
      { ...params, visible: true },
      undefined,
      runtime,
      CONVERSATION_SURFACE_METHODS
    )
    expect(stale).toHaveProperty('error')
    expect(publish).toHaveBeenCalledTimes(1)
  } finally {
    setStructuredAgentSessionHost(null)
  }
})
