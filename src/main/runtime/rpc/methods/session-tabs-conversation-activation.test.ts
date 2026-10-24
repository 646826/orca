import { afterEach, expect, it, vi } from 'vitest'
import {
  attach,
  hostTestState
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestOperationId
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { fixture as layoutFixture } from '../../../persistence/loading-store/profile-state-delayed-authority-fixture'
import { makeRuntimeStoreWithWorkspaceSession } from '../../orca-runtime-test-fixtures.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { NATIVE_CONVERSATION_RUNTIME_CAPABILITY } from '../../../../shared/conversation-runtime-capabilities'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { codexProviderHandle } from '../../../../shared/agent-session-provider-handle-encoding'
import { restoreConversationTabSurfaces } from '../../conversation-tab-restoration'
import { RpcDispatcher } from '../dispatcher'
import type { RpcResponse } from '../core'
import { SESSION_TAB_METHODS } from './session-tabs'

afterEach(() => setStructuredAgentSessionHost(null))

async function setup() {
  await attach()
  const { host, store, acquire } = hostTestState()
  const acquisition = await acquire.mock.results[0]!.value
  acquire.mockResolvedValueOnce({
    ...acquisition,
    acquisitionGeneration: globalThis.crypto.randomUUID(),
    link: {
      ...acquisition.link,
      handle: codexProviderHandle('019fd532-7c11-7a90-b6de-4e1a2c3d5f61')
    }
  })
  const attached = await host.attach(
    { callerKey: 'client-1' },
    hostTestAttachParams(null, {
      envelope: {
        sessionId: 'session-beta',
        expectedRuntimeFence: null,
        clientOperationId: hostTestOperationId(),
        payloadFingerprint: ''
      },
      providerHandle: { kind: 'codex', threadId: '019fd532-7c11-7a90-b6de-4e1a2c3d5f61' }
    })
  )
  expect(attached.ok).toBe(true)
  for (const [sessionId, tabId] of [
    [HOST_TEST_SESSION, 'conversation-a'],
    ['session-beta', 'conversation-b']
  ]) {
    await store.setSessionTabVisibility(sessionId, true, tabId)
    const conversation = await host.conversationEnrollment.ensure(sessionId)
    await host.conversationEnrollment.promote(
      {
        conversationId: conversation.conversationId,
        sourceSessionId: sessionId,
        expectedTabId: tabId,
        expectedRevision: conversation.revision
      },
      () => {}
    )
  }
  const worktree = store.getRecord(HOST_TEST_SESSION)!.location.workspaceId
  const { store: layoutStore } = await layoutFixture()
  layoutStore.setWorkspaceSession(getDefaultWorkspaceSession())
  await layoutStore.flushPendingOrThrowAsync()
  await restoreConversationTabSurfaces({
    hostId: 'local',
    list: () => host.listConversationSurfaces({ executionHostId: 'local', includeHidden: true }),
    readSession: () => layoutStore.getWorkspaceSession(),
    applyLayoutCommand: layoutStore.applyLayoutCommand.bind(layoutStore),
    flush: () => layoutStore.flushPendingOrThrowAsync(),
    acknowledge: (input) => store.conversations.surfaces.acknowledge(input)
  })
  const fixture = makeRuntimeStoreWithWorkspaceSession(layoutStore.getWorkspaceSession())
  const session = fixture.getSession()
  fixture.setSession({
    ...session,
    activeTabIdByWorktree: { ...session.activeTabIdByWorktree, [worktree]: 'conversation-b' },
    tabGroups: {
      ...session.tabGroups,
      [worktree]: session.tabGroups![worktree]!.map((group) => ({
        ...group,
        activeTabId: 'conversation-b'
      }))
    }
  })
  const runtime = new OrcaRuntimeService(fixture.runtimeStore)
  // The fake-adapter host above is already restored; no provider discovery belongs to navigation.
  vi.spyOn(runtime, 'restoreStructuredAgentSessionTabs').mockResolvedValue(undefined)
  setStructuredAgentSessionHost(host)
  runtime.publishConversationInventory(worktree)
  const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
  const call = async (
    method: string,
    params: Record<string, unknown>,
    pairedDeviceId: string | null = 'caller-a',
    capabilities = [
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
      NATIVE_CONVERSATION_RUNTIME_CAPABILITY
    ]
  ) => {
    const replies: RpcResponse[] = []
    await dispatcher.dispatchStreaming(
      {
        id: 'navigation',
        authToken: 'token',
        method,
        params: { worktree: `id:${worktree}`, ...params }
      },
      (raw) => replies.push(JSON.parse(raw)),
      {
        ...(pairedDeviceId ? { clientKind: 'runtime' as const, pairedDeviceId } : {}),
        clientCapabilities: capabilities
      }
    )
    return replies[0]!
  }
  return { runtime, fixture, worktree, call, host, store, dispatcher }
}

it('activates a published conversation-only surface through real host navigation without stealing another client', async () => {
  const { runtime, fixture, worktree, call, dispatcher } = await setup()
  const updates: RpcResponse[] = []
  const controller = new AbortController()
  await dispatcher.dispatchStreaming(
    {
      id: 'subscription',
      authToken: 'token',
      method: 'session.tabs.subscribe',
      params: { worktree: `id:${worktree}` }
    },
    (raw) => updates.push(JSON.parse(raw)),
    {
      clientKind: 'runtime',
      pairedDeviceId: 'caller-a',
      clientCapabilities: [
        STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
        NATIVE_CONVERSATION_RUNTIME_CAPABILITY
      ],
      signal: controller.signal
    }
  )
  expect(await call('session.tabs.list', {}, 'caller-b')).toMatchObject({
    result: {
      activeTabId: 'conversation-b',
      tabs: expect.arrayContaining([expect.objectContaining({ type: 'conversation' })])
    }
  })
  const activated = await call('session.tabs.activate', {
    tabId: 'conversation-a',
    navigation: 'caller',
    notifyClients: false
  })
  expect(activated).not.toHaveProperty('error')
  expect(activated).toMatchObject({
    result: { activeTabId: 'conversation-a', activeTabType: 'conversation' }
  })
  runtime.publishConversationInventory(worktree)
  expect(updates.at(-1)).toMatchObject({
    result: { type: 'updated', activeTabId: 'conversation-a', activeTabType: 'conversation' }
  })
  expect(await call('session.tabs.list', {})).toMatchObject({
    result: { activeTabId: 'conversation-a' }
  })
  expect(await call('session.tabs.list', {}, 'caller-b')).toMatchObject({
    result: { activeTabId: 'conversation-b' }
  })
  expect(fixture.getSession().activeTabIdByWorktree?.[worktree]).toBe('conversation-b')
  controller.abort()
})

it('activates the same published surface for a trusted local caller without a native-session alias', async () => {
  const { call } = await setup()
  expect(
    await call('session.tabs.activate', { tabId: 'conversation-a', navigation: 'caller' }, null)
  ).toMatchObject({ result: { activeTabId: 'conversation-a', activeTabType: 'conversation' } })
})

it.each(['host', 'all', 'clients'] as const)(
  'refuses unsupported conversation navigation %s',
  async (navigation) => {
    const { call, fixture, worktree } = await setup()
    expect(
      await call('session.tabs.activate', { tabId: 'conversation-a', navigation })
    ).toMatchObject({
      error: { code: 'conversation_refused', data: { reason: 'unsupported' } }
    })
    expect(fixture.getSession().activeTabIdByWorktree?.[worktree]).toBe('conversation-b')
  }
)

it('refuses a hidden surface, foreign workspace, and a client without the mutation capability', async () => {
  const { call, host, store, fixture, worktree } = await setup()
  expect(
    await call(
      'session.tabs.activate',
      { tabId: 'conversation-a', navigation: 'caller' },
      'old-client',
      [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
    )
  ).toHaveProperty('error')
  expect(
    await call('session.tabs.activate', {
      worktree: 'id:foreign-workspace',
      tabId: 'conversation-a',
      navigation: 'caller'
    })
  ).toHaveProperty('error')
  const conversation = store.conversations.membership(HOST_TEST_SESSION)!
  const surface = host.deps.store.conversations.surfaces.read(conversation.conversationId)!
  await store.conversations.surfaces.setVisibility(
    {
      conversationId: conversation.conversationId,
      expectedSurfaceRevision: surface.surfaceRevision,
      visible: false
    },
    () => {}
  )
  expect(
    await call('session.tabs.activate', { tabId: 'conversation-a', navigation: 'caller' })
  ).toMatchObject({
    error: { code: 'conversation_refused', data: { reason: 'source-unavailable' } }
  })
  expect(fixture.getSession().activeTabIdByWorktree?.[worktree]).toBe('conversation-b')
})

vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
