import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NATIVE_CONVERSATION_RUNTIME_CAPABILITY } from '../../../../shared/conversation-runtime-capabilities'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import {
  startConversationEntry,
  readConversationEntry,
  retryConversationEntry,
  subscribeConversationEntry,
  forgetConversationEntriesOwnedBy
} from './native-chat-conversation-entry'
import { entrySnapshot } from './native-chat-conversation-entry.test-fixture'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc,
  runtimeEnvironmentSupportsCapability: async () => true
}))
vi.mock('./structured-agent-session-operation-id', () => ({
  structuredSessionOperationId: () => 'fixed-op'
}))
beforeEach(() => {
  rpc.mockReset()
  setLocalRuntimeCapabilitiesForTests([NATIVE_CONVERSATION_RUNTIME_CAPABILITY])
})
afterEach(() => forgetConversationEntriesOwnedBy({ workspaceId: 'w', executionHostId: 'local' }))
it('refuses an old full-conversation host before enrollment and rechecks it on retry', async () => {
  setLocalRuntimeCapabilitiesForTests(['agent-session.conversations.v1'])
  rpc.mockReset().mockResolvedValue(entrySnapshot.conversation)
  const target = { kind: 'local' } as const
  await startConversationEntry({
    target,
    tabId: 'old-host',
    sessionId: 'a',
    workspaceId: 'w',
    agent: 'codex'
  })
  await retryConversationEntry(target, 'old-host')
  expect(rpc).not.toHaveBeenCalled()
  expect(readConversationEntry(target, 'old-host')).toMatchObject({
    busy: false,
    error: { reason: 'unsupported' }
  })
})
it('continues after promotion unmount and retries only the identical unresolved selection', async () => {
  const target = { kind: 'local' } as const
  const tabId = 'entry-tab'
  const snapshot = {
    ...entrySnapshot,
    conversation: { ...entrySnapshot.conversation, pendingOperationKey: null },
    operation: null,
    surface: {
      conversationId: 'c',
      tabId,
      sourceSessionId: 'a',
      location: entrySnapshot.conversation.location,
      surfaceRevision: 1,
      publishedRevision: 1,
      visible: true
    }
  }
  const listener = vi.fn()
  const unmount = subscribeConversationEntry(listener)
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'conversation.ensure') {
      return { ...snapshot.conversation, sourceTabId: tabId }
    }
    if (method === 'conversation.promoteSurface') {
      unmount()
      return snapshot
    }
    throw new Error('reply lost')
  })
  const first = startConversationEntry({
    target,
    tabId,
    sessionId: 'a',
    workspaceId: 'w',
    agent: 'codex'
  })
  await startConversationEntry({
    target,
    tabId,
    sessionId: 'a',
    workspaceId: 'w',
    agent: 'opencode'
  })
  await first
  expect(rpc.mock.calls.map((call) => call[1])).toEqual([
    'conversation.ensure',
    'conversation.promoteSurface',
    'conversation.selectAgent'
  ])
  expect(readConversationEntry(target, tabId)?.busy).toBe(false)
  const selected = rpc.mock.calls[2][2]
  setLocalRuntimeCapabilitiesForTests(['agent-session.conversations.v1'])
  await retryConversationEntry(target, tabId)
  expect(rpc).toHaveBeenCalledTimes(3)
  expect(readConversationEntry(target, tabId)?.selection).toEqual(selected)
  setLocalRuntimeCapabilitiesForTests([NATIVE_CONVERSATION_RUNTIME_CAPABILITY])
  rpc.mockResolvedValueOnce({ decision: 'replayed', snapshot })
  await retryConversationEntry(target, tabId)
  expect(rpc.mock.calls[3][2]).toEqual(selected)
  expect(selected).toMatchObject({ agent: 'codex', clientOperationId: 'fixed-op' })
  expect(readConversationEntry(target, tabId)).toBeNull()
})

it('native rebuild keeps the selected agent and exact final request across a lost reply', async () => {
  const { startConversationRebuild } = await import('./native-chat-conversation-entry')
  const target = { kind: 'local' } as const
  const tabId = 'rebuild-tab'
  const selected = {
    ...entrySnapshot.active,
    sessionId: 'b',
    agent: 'codex' as const,
    agentLabel: 'Codex'
  }
  const snapshot = { ...entrySnapshot, selected }
  const afterCancel = {
    ...snapshot,
    conversation: { ...snapshot.conversation, revision: 4, pendingOperationKey: null },
    operation: null
  }
  rpc
    .mockReset()
    .mockResolvedValueOnce({ ...entrySnapshot.operation, phase: 'cancelled' })
    .mockResolvedValueOnce(afterCancel)
    .mockRejectedValueOnce(new Error('lost selection reply'))
  await startConversationRebuild(target, tabId, snapshot)
  expect(rpc.mock.calls.map((call) => call[1])).toEqual([
    'conversation.cancel',
    'conversation.surfaceRead',
    'conversation.selectAgent'
  ])
  const request = rpc.mock.calls[2][2]
  expect(request).toMatchObject({
    agent: 'codex',
    nativeSession: 'rebuild',
    expectedRevision: 4,
    clientOperationId: 'fixed-op'
  })
  rpc.mockResolvedValueOnce({ decision: 'replayed', snapshot: afterCancel })
  await retryConversationEntry(target, tabId)
  expect(rpc.mock.calls[3][1]).toBe('conversation.selectAgent')
  expect(rpc.mock.calls[3][2]).toEqual(request)
  expect(readConversationEntry(target, tabId)).toBeNull()
})

it.each([
  {
    response: entrySnapshot.conversation,
    message: 'Conversation host does not support canonical source surface identity'
  },
  {
    response: {
      ...entrySnapshot.conversation,
      sourceTabId: 'canonical-source',
      location: { ...entrySnapshot.conversation.location, workspaceId: 'other-workspace' }
    },
    message: 'Conversation enrollment scope changed'
  },
  {
    response: {
      ...entrySnapshot.conversation,
      sourceTabId: 'canonical-source',
      location: { ...entrySnapshot.conversation.location, executionHostId: 'runtime:other-host' }
    },
    message: 'Conversation enrollment scope changed'
  }
])(
  'refuses unverified source metadata before promotion: $message',
  async ({ response, message }) => {
    rpc.mockReset().mockResolvedValueOnce(response)
    const target = { kind: 'local' } as const
    await startConversationEntry({
      target,
      tabId: 'unverified-source',
      sessionId: 'a',
      workspaceId: 'w',
      agent: 'codex'
    })
    expect(readConversationEntry(target, 'unverified-source')).toMatchObject({
      busy: false,
      error: { message }
    })
    expect(rpc.mock.calls.map((call) => call[1])).toEqual(['conversation.ensure'])
  }
)
