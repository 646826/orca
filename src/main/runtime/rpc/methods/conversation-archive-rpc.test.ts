import { expect, it, vi } from 'vitest'
import {
  attach,
  hostTestState,
  CALLER
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION,
  HOST_TEST_NOW,
  hostTestOperationId
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { call } from './structured-agent-session-rpc.test-fixture'
import { CONVERSATION_ARCHIVE_METHODS } from './conversation-archive-methods'

it('deletes only a retired archive through the authenticated dispatcher and resumes its cleanup identity', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(HOST_TEST_NOW)
  await attach()
  const { host, store } = hostTestState()
  host.deps.hasOpenDispatch = () => false
  const initial = await store.conversations.ensureSingleton(HOST_TEST_SESSION)
  const begun = await store.conversations.clear.begin(
    {
      conversationId: initial.conversationId,
      expectedRevision: initial.revision,
      expectedContextGeneration: initial.contextGeneration,
      expectedActivationFence: initial.activationFence
    },
    {
      callerKey: CALLER.callerKey,
      operationId: hostTestOperationId(),
      fingerprint: 'clear',
      now: HOST_TEST_NOW
    }
  )
  if (!begun.intent) {
    throw new Error('Missing clear intent')
  }
  expect(
    await host.advanceConversationClear(begun.intent.operationKey, new AbortController().signal)
  ).toEqual({ kind: 'committed' })
  const current = store.conversations.read(initial.conversationId)!
  const publish = vi.fn(async () => {})
  const runtime = {
    ensureStructuredAgentSessionHost: async () => {
      setStructuredAgentSessionHost(host)
      return host
    },
    publishConversationSurfaces: publish
  }
  try {
    const params = {
      conversationId: current.conversationId,
      expectedRevision: current.revision,
      contextGeneration: 1,
      clientOperationId: hostTestOperationId()
    }
    expect(
      await call(
        'conversation.deleteArchive',
        params,
        { clientKind: 'runtime', clientCapabilities: [] },
        runtime,
        CONVERSATION_ARCHIVE_METHODS
      )
    ).toHaveProperty('error')
    expect(store.conversations.archive.status(current.conversationId, 1)).toBeNull()
    expect(
      await call(
        'conversation.deleteArchive',
        { ...params, clientOperationId: 'bad' },
        undefined,
        runtime,
        CONVERSATION_ARCHIVE_METHODS
      )
    ).toHaveProperty('error')
    expect(
      await call(
        'conversation.deleteArchive',
        params,
        undefined,
        runtime,
        CONVERSATION_ARCHIVE_METHODS
      )
    ).not.toHaveProperty('error')
    const status = store.conversations.archive.status(current.conversationId, 1)!
    expect(publish).toHaveBeenCalledOnce()
    expect(
      await call(
        'conversation.archiveStatus',
        { conversationId: current.conversationId, contextGeneration: 1 },
        undefined,
        runtime,
        CONVERSATION_ARCHIVE_METHODS
      )
    ).not.toHaveProperty('error')
    for (
      let i = 0;
      i < 100 &&
      store.conversations.archive.status(current.conversationId, 1)?.phase !== 'complete';
      i++
    ) {
      expect(
        await call(
          'conversation.cleanupArchive',
          { conversationId: current.conversationId, operationKey: status.operationKey },
          undefined,
          runtime,
          CONVERSATION_ARCHIVE_METHODS
        )
      ).not.toHaveProperty('error')
    }
    expect(store.conversations.archive.status(current.conversationId, 1)).toEqual({
      ...status,
      phase: 'complete'
    })
    expect(store.conversations.read(current.conversationId)?.contextGeneration).toBe(2)
  } finally {
    setStructuredAgentSessionHost(null)
  }
})
