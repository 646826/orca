// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  startConversationEntry,
  readConversationEntry,
  retryConversationEntry,
  forgetConversationEntriesOwnedBy
} from '../../src/renderer/src/components/native-chat/native-chat-conversation-entry'
import {
  attach,
  hostTestState
} from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import { call } from '../../src/main/runtime/rpc/methods/structured-agent-session-rpc.test-fixture'
import { CONVERSATION_METHODS } from '../../src/main/runtime/rpc/methods/conversation-methods'
import { CONVERSATION_SURFACE_METHODS } from '../../src/main/runtime/rpc/methods/conversation-surface-methods'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-result'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { applyLocalStructuredSessionTabSnapshots } from '@/runtime/local-structured-session-tabs-sync/snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from '@/runtime/local-structured-session-tabs-sync/inventory-generation-fence'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/snapshot-api'
import {
  makeState,
  makeSnapshot,
  resetWebSessionTabsSyncTestState
} from '@/runtime/web-session-tabs-sync-test-harness'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '@/runtime/local-structured-session-owner'
import { resolveHostSessionTabIdForWebSessionTab } from '@/runtime/web-session-tabs-sync/tracking-mappings'
import { structuredAgentSessionTabId } from '../../src/shared/structured-agent-session-projection'
import { ConversationEnsureParams } from '../../src/shared/rpc-contract/conversation-params'
import { NATIVE_CONVERSATION_RUNTIME_CAPABILITY } from '../../src/shared/conversation-runtime-capabilities'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc,
  runtimeEnvironmentSupportsCapability: async () => true
}))
const workspaceId = 'workspace-1'
const localTabId = 'renderer-source-pane'
const sourceTabId = 'reserved-host-source-pane'
const environmentId = 'entry-identity-env'

beforeEach(async () => {
  setLocalRuntimeCapabilitiesForTests([NATIVE_CONVERSATION_RUNTIME_CAPABILITY])
  resetWebSessionTabsSyncTestState()
  resetLocalStructuredSessionVersionForTests()
  rpc.mockReset()
  await attach()
  const { host, store } = hostTestState()
  setStructuredAgentSessionHost(host)
  await store.setSessionTabVisibility(HOST_TEST_SESSION, true, sourceTabId)
  rpc.mockImplementation(async (_target, method: string, params: unknown) => {
    if (method === 'conversation.selectAgent') {
      throw new Error('selection reply lost')
    }
    return unwrapRuntimeRpcResult(
      await call(method, params, undefined, { publishConversationSurfaces: async () => {} }, [
        ...CONVERSATION_METHODS,
        ...CONVERSATION_SURFACE_METHODS
      ])
    )
  })
})

afterEach(() => {
  forgetConversationEntriesOwnedBy({ workspaceId, executionHostId: 'local' })
  forgetConversationEntriesOwnedBy({ workspaceId, executionHostId: `runtime:${environmentId}` })
  replaceRuntimeEnvironmentRevisions([])
  setStructuredAgentSessionHost(null)
})

it('does not enroll or detach the native participant when the host advertises only the old full contract', async () => {
  const { store } = hostTestState()
  setLocalRuntimeCapabilitiesForTests(['agent-session.conversations.v1'])
  const target = { kind: 'local' } as const
  await startConversationEntry({
    target,
    tabId: localTabId,
    sessionId: HOST_TEST_SESSION,
    workspaceId,
    agent: 'codex'
  })
  await retryConversationEntry(target, localTabId)
  expect(rpc).not.toHaveBeenCalled()
  expect(store.conversations.membership(HOST_TEST_SESSION)).toBeNull()
  expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe(sourceTabId)
  expect(readConversationEntry(target, localTabId)?.error).toMatchObject({ reason: 'unsupported' })
})

describe.each(['local', 'remote'] as const)('%s conversation entry identity', (owner) => {
  it.each([
    { durableTabId: sourceTabId, collision: false },
    { durableTabId: structuredAgentSessionTabId(HOST_TEST_SESSION), collision: false },
    { durableTabId: sourceTabId, collision: true }
  ])(
    'promotes durable tab $durableTabId, not renderer or inventory aliases (collision: $collision)',
    async ({ durableTabId, collision }) => {
      const { store } = hostTestState()
      await store.setSessionTabVisibility(HOST_TEST_SESSION, false)
      await store.setSessionTabVisibility(HOST_TEST_SESSION, true, durableTabId)
      const target =
        owner === 'local'
          ? ({ kind: 'local' } as const)
          : ({ kind: 'environment', environmentId } as const)
      const executionHostId = owner === 'local' ? 'local' : (`runtime:${environmentId}` as const)
      const baseId = structuredAgentSessionTabId(HOST_TEST_SESSION)
      const rendererTabId = collision ? `${baseId}:history-1` : localTabId
      if (owner === 'remote') {
        replaceRuntimeEnvironmentRevisions([
          { id: environmentId, createdAt: 1, pairingRevision: 7 }
        ])
      }
      const state = makeState({
        activeWorktreeId: workspaceId,
        unifiedTabsByWorktree: {
          [workspaceId]: [
            {
              id: collision ? baseId : localTabId,
              entityId: HOST_TEST_SESSION,
              contentType: 'agent-session',
              executionHostId: collision ? 'runtime:foreign-host' : executionHostId,
              worktreeId: workspaceId,
              groupId: 'renderer-group',
              label: 'Source chat',
              customLabel: null,
              color: null,
              isPinned: false,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      })
      const inventoryTabId = `agent-session:${HOST_TEST_SESSION}`
      const snapshot = makeSnapshot(
        [
          {
            type: 'agent-session',
            id: inventoryTabId,
            sessionId: HOST_TEST_SESSION,
            agent: 'codex',
            title: 'Source chat',
            isActive: true
          }
        ],
        { worktree: workspaceId }
      )
      const mirrored =
        owner === 'local'
          ? applyLocalStructuredSessionTabSnapshots(state, [snapshot])
          : { ...state, ...applyWebSessionTabsSnapshot(state, snapshot, environmentId) }
      expect(
        mirrored.unifiedTabsByWorktree[workspaceId]?.find(
          (tab) => tab.executionHostId === executionHostId
        )?.id
      ).toBe(rendererTabId)
      expect(
        resolveHostSessionTabIdForWebSessionTab(mirrored, {
          environmentId: owner === 'local' ? LOCAL_STRUCTURED_SESSION_OWNER : environmentId,
          worktreeId: workspaceId,
          tabId: rendererTabId
        })
      ).toBe(inventoryTabId)
      const nativeRecord = store.getRecord(HOST_TEST_SESSION)
      await startConversationEntry({
        target,
        tabId: rendererTabId,
        sessionId: HOST_TEST_SESSION,
        workspaceId,
        agent: 'claude'
      })
      const attempt = readConversationEntry(target, rendererTabId)
      expect(attempt?.error).toMatchObject({ message: 'selection reply lost' })
      expect(attempt?.selection).toMatchObject({
        agent: 'claude',
        nativeSession: 'retain-or-create'
      })
      expect(readConversationEntry(target, durableTabId)).toBeNull()
      const conversation = store.conversations.membership(HOST_TEST_SESSION)
      expect(conversation).not.toBeNull()
      expect(store.conversations.surfaces.read(conversation!.conversationId)).toMatchObject({
        tabId: durableTabId,
        sourceSessionId: HOST_TEST_SESSION
      })
      expect(store.getRecord(HOST_TEST_SESSION)).toEqual(nativeRecord)
      const selection = attempt?.selection
      await retryConversationEntry(target, rendererTabId)
      expect(readConversationEntry(target, rendererTabId)?.selection).toEqual(selection)
      expect(
        rpc.mock.calls.filter((entry) => entry[1] === 'conversation.promoteSurface')
      ).toHaveLength(1)
    }
  )
})

const localEntry = {
  target: { kind: 'local' } as const,
  tabId: localTabId,
  sessionId: HOST_TEST_SESSION,
  workspaceId,
  agent: 'claude' as const
}

it('retries a lost promotion reply with the captured durable ID after its native tab is detached', async () => {
  const forward = rpc.getMockImplementation()!
  let loseReply = true
  rpc.mockImplementation(async (...args) => {
    const result = await forward(...args)
    if (args[1] === 'conversation.promoteSurface' && loseReply) {
      loseReply = false
      throw new Error('promotion reply lost')
    }
    return result
  })
  await startConversationEntry(localEntry)
  expect(readConversationEntry(localEntry.target, localTabId)).toMatchObject({
    sourceTabId,
    error: { message: 'promotion reply lost' }
  })
  expect(hostTestState().store.getSessionTabId(HOST_TEST_SESSION)).toBeNull()
  await retryConversationEntry(localEntry.target, localTabId)
  expect(readConversationEntry(localEntry.target, localTabId)?.selection).toMatchObject({
    agent: 'claude'
  })
  expect(rpc.mock.calls.filter((entry) => entry[1] === 'conversation.ensure')).toHaveLength(1)
})

it('keeps strict promotion authority when the host source tab changes after enrollment', async () => {
  const forward = rpc.getMockImplementation()!
  const { store } = hostTestState()
  rpc.mockImplementation(async (...args) => {
    const result = await forward(...args)
    if (args[1] === 'conversation.ensure') {
      await store.setSessionTabVisibility(HOST_TEST_SESSION, false)
      await store.setSessionTabVisibility(HOST_TEST_SESSION, true, 'replacement-host-pane')
    }
    return result
  })
  await startConversationEntry(localEntry)
  const attempt = readConversationEntry(localEntry.target, localTabId)
  expect(attempt?.error).toMatchObject({
    response: { error: { data: { reason: 'identity-mismatch' } } }
  })
  expect(attempt?.selection).toBeUndefined()
  expect(store.conversations.surfaces.read(attempt!.conversation!.conversationId)).toBeNull()
  expect(store.getSessionTabId(HOST_TEST_SESSION)).toBe('replacement-host-pane')
})

it('fails closed against a strict older host without retrying enrollment under a guessed ID', async () => {
  const legacyMethods = CONVERSATION_METHODS.map((method) =>
    method.name === 'conversation.ensure'
      ? { ...method, params: ConversationEnsureParams.omit({ includeSourceSurface: true }) }
      : method
  )
  rpc.mockImplementation(async (_target, method: string, params: unknown) =>
    unwrapRuntimeRpcResult(await call(method, params, undefined, {}, legacyMethods))
  )
  await startConversationEntry(localEntry)
  const attempt = readConversationEntry(localEntry.target, localTabId)
  expect(attempt?.error).toMatchObject({
    code: 'invalid_argument',
    message: expect.stringContaining('includeSourceSurface')
  })
  expect(attempt?.conversation).toBeUndefined()
  expect(hostTestState().store.conversations.membership(HOST_TEST_SESSION)).toBeNull()
  expect(hostTestState().store.getSessionTabId(HOST_TEST_SESSION)).toBe(sourceTabId)
  expect(rpc).toHaveBeenCalledTimes(1)
})
