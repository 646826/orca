import { expect, test } from 'vitest'
import {
  attach,
  hostTestState
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { CONVERSATION_SURFACE_METHODS } from './conversation-surface-methods'
import { call } from './structured-agent-session-rpc.test-fixture'
import { ConversationSelectAgentResultSchema } from '../../../../shared/conversation-surface-rpc'

test('RPC selection resolves the target on host and commits a parked candidate without native acquisition', async () => {
  await attach()
  const { host, store, acquire } = hostTestState()
  const source = store.getRecord(HOST_TEST_SESSION)!
  const conversation = await host.conversationEnrollment.ensure(HOST_TEST_SESSION)
  const count = acquire.mock.calls.length
  const params = {
    conversationId: conversation.conversationId,
    expectedRevision: conversation.revision,
    expectedContextGeneration: conversation.contextGeneration,
    expectedActivationFence: conversation.activationFence,
    agent: 'codex',
    nativeSession: 'rebuild',
    clientOperationId: `${Date.now()}-${'9'.repeat(32)}`
  }
  try {
    const overrides = {
      ensureStructuredAgentSessionHost: async () => {
        setStructuredAgentSessionHost(host)
        return host
      },
      resolveStructuredAgentSessionCreateIntent: async () => ({
        agent: 'codex',
        provider: 'codex',
        location: source.location,
        accountHome: source.accountHome,
        runtimeKind: 'native'
      })
    }
    const wrongScope = await call(
      'conversation.selectAgent',
      params,
      undefined,
      {
        ...overrides,
        resolveStructuredAgentSessionCreateIntent: async () => ({
          agent: 'codex',
          provider: 'codex',
          location: { ...source.location, wslDistro: 'other-distro' },
          accountHome: source.accountHome,
          runtimeKind: 'native'
        })
      },
      CONVERSATION_SURFACE_METHODS
    )
    expect(wrongScope).toHaveProperty('error')
    expect(store.listRecords()).toHaveLength(1)
    expect(acquire).toHaveBeenCalledTimes(count)
    const response = await call(
      'conversation.selectAgent',
      params,
      undefined,
      overrides,
      CONVERSATION_SURFACE_METHODS
    )
    expect(response).not.toHaveProperty('error')
    if (!('result' in response)) {
      throw new Error('missing RPC result')
    }
    const result = ConversationSelectAgentResultSchema.parse(response.result)
    expect(result.decision).toBe('admitted')
    expect(JSON.stringify(result)).not.toContain('accountHome')
    expect(result.snapshot.active.sessionId).toBe(source.sessionId)
    expect(result.snapshot.selected?.sessionId).not.toBe(source.sessionId)
    expect(acquire).toHaveBeenCalledTimes(count)
    const selected = result.snapshot.selected!
    expect(store.getSessionTabId(selected.sessionId)).toBeNull()
    const replay = await call(
      'conversation.selectAgent',
      params,
      undefined,
      overrides,
      CONVERSATION_SURFACE_METHODS
    )
    if (!('result' in replay)) {
      throw new Error(JSON.stringify(replay))
    }
    expect(
      ConversationSelectAgentResultSchema.parse(replay.result).snapshot.selected?.sessionId
    ).toBe(selected.sessionId)
    expect(acquire).toHaveBeenCalledTimes(count)
  } finally {
    setStructuredAgentSessionHost(null)
  }
})
