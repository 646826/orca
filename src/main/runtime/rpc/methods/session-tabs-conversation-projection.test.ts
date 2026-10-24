import { expect, test, vi } from 'vitest'
import {
  attach,
  hostTestState
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import {
  NATIVE_CONVERSATION_RUNTIME_CAPABILITY,
  NATIVE_CONVERSATION_READ_CAPABILITY
} from '../../../../shared/conversation-runtime-capabilities'
import { withChatTabChanges } from '../../agent-session-tab-layout'
import {
  restoreConversationTabSurfaces,
  publishRuntimeConversationSurfaces
} from '../../conversation-tab-restoration'
import { SESSION_TAB_METHODS } from './session-tabs'
import { fixture } from '../../../persistence/loading-store/profile-state-delayed-authority-fixture'
import { call, STRUCTURED_CLIENT } from './structured-agent-session-rpc.test-fixture'

test.each(
  [
    'session.tabs.list',
    'session.tabs.listAll',
    'session.tabs.subscribe',
    'session.tabs.subscribeAll'
  ].flatMap((method) =>
    [NATIVE_CONVERSATION_RUNTIME_CAPABILITY, NATIVE_CONVERSATION_READ_CAPABILITY].map(
      (capability) => ({ method, capability })
    )
  )
)(
  'projects durable conversation identity via $method for $capability without native duplicates',
  async ({ method, capability }) => {
    await attach()
    const { host, store } = hostTestState()
    const record = store.getRecord(HOST_TEST_SESSION)!
    const worktree = record.location.workspaceId
    await store.setSessionTabVisibility(HOST_TEST_SESSION, true, 'visual-conversation')
    const conversation = await host.conversationEnrollment.ensure(HOST_TEST_SESSION)
    await host.conversationEnrollment.promote(
      {
        conversationId: conversation.conversationId,
        sourceSessionId: HOST_TEST_SESSION,
        expectedTabId: 'visual-conversation',
        expectedRevision: conversation.revision
      },
      () => undefined
    )
    const { store: layoutStore } = await fixture()
    const session = withChatTabChanges('local', getDefaultWorkspaceSession(), worktree, [
      { open: { sessionId: HOST_TEST_SESSION, agent: 'codex', tabId: 'visual-conversation' } }
    ])!
    layoutStore.setWorkspaceSession(session)
    await layoutStore.flushPendingOrThrowAsync()
    await restoreConversationTabSurfaces({
      hostId: 'local',
      list: () => host.listConversationSurfaces({ executionHostId: 'local', includeHidden: true }),
      readSession: () => layoutStore.getWorkspaceSession(),
      applyLayoutCommand: layoutStore.applyLayoutCommand.bind(layoutStore),
      flush: () => layoutStore.flushPendingOrThrowAsync(),
      acknowledge: (input) => store.conversations.surfaces.acknowledge(input)
    })
    setStructuredAgentSessionHost(host)
    try {
      const response = await call(
        method,
        method.endsWith('All') ? undefined : { worktree: `id:${worktree}` },
        {
          ...STRUCTURED_CLIENT,
          clientCapabilities: [...STRUCTURED_CLIENT.clientCapabilities, capability]
        },
        {
          supportsAuthoritativeSessionTabsInventory: () => false,
          listAllMobileSessionTabs: async () => [],
          listAllMobileSessionTabsWithChangeSequence: async () => ({
            snapshots: [],
            changeSequence: 0
          }),
          onMobileSessionTabsChanged: () => () => {},
          getWorkspaceSessionForWorktree: () => layoutStore.getWorkspaceSession(),
          listMobileSessionTabs: async () => ({
            worktree,
            publicationEpoch: 'epoch',
            snapshotVersion: 1,
            activeGroupId: null,
            activeTabId: null,
            activeTabType: null,
            tabs: [
              {
                type: 'agent-session',
                id: 'stale-native',
                sessionId: HOST_TEST_SESSION,
                agent: 'codex',
                title: 'Legacy duplicate',
                isActive: false
              },
              {
                type: 'terminal',
                id: 'leaf',
                parentTabId: 'shell',
                leafId: 'leaf',
                title: 'Shell',
                isActive: false
              },
              {
                type: 'browser',
                id: 'browser-leaf',
                browserWorkspaceId: 'browser-parent',
                title: 'Browser',
                isActive: false
              }
            ],
            tabGroups: [
              { id: 'runtime-shell-group', tabOrder: ['shell'], activeTabId: 'shell' },
              {
                id: 'runtime-browser-group',
                tabOrder: ['browser-parent'],
                activeTabId: 'browser-parent'
              }
            ],
            tabGroupLayout: { type: 'leaf', groupId: 'runtime-shell-group' }
          })
        },
        SESSION_TAB_METHODS
      )
      expect(response).not.toHaveProperty('error')
      if (!('result' in response)) {
        throw new Error('Missing list reply')
      }
      const payload = response.result
      const view =
        payload &&
        typeof payload === 'object' &&
        'snapshots' in payload &&
        Array.isArray(payload.snapshots)
          ? payload.snapshots[0]
          : payload
      if (method.endsWith('All')) {
        expect(payload).toHaveProperty('conversationSurfacesComplete', true)
      }
      expect({ result: view }).toMatchObject({
        result: {
          tabs: [
            { type: 'terminal', id: 'leaf' },
            { type: 'browser', id: 'browser-leaf' },
            {
              type: 'conversation',
              id: 'visual-conversation',
              conversationId: conversation.conversationId,
              activeSessionId: HOST_TEST_SESSION,
              activeAgent: 'codex'
            }
          ],
          conversationSurfaces: { complete: true }
        }
      })
      if (!('result' in response)) {
        throw new Error('Missing list reply')
      }
      expect(JSON.stringify(response.result)).not.toContain('stale-native')
      expect(view).toHaveProperty(
        'tabGroups',
        expect.arrayContaining([
          { id: 'runtime-shell-group', tabOrder: ['shell'], activeTabId: 'shell' },
          {
            id: 'runtime-browser-group',
            tabOrder: ['browser-parent'],
            activeTabId: 'browser-parent'
          }
        ])
      )
      const visible = store.conversations.surfaces.read(conversation.conversationId)!
      await store.conversations.surfaces.setVisibility(
        {
          conversationId: conversation.conversationId,
          expectedSurfaceRevision: visible.surfaceRevision,
          visible: false
        },
        () => undefined
      )
      const notify = vi.fn()
      let diskFailed = true
      const persistence = {
        getWorkspaceSession: () => layoutStore.getWorkspaceSession(),
        applyLayoutCommand: layoutStore.applyLayoutCommand.bind(layoutStore),
        flushPendingOrThrowAsync: async () => {
          if (diskFailed) {
            throw new Error('disk full')
          }
          await layoutStore.flushPendingOrThrowAsync()
        }
      }
      await expect(
        publishRuntimeConversationSurfaces('local', host, () => persistence, notify)
      ).rejects.toThrow('disk full')
      expect(notify).not.toHaveBeenCalled()
      expect(
        store.conversations.surfaces.read(conversation.conversationId)?.publishedRevision
      ).toBe(visible.publishedRevision)
      diskFailed = false
      await expect(
        publishRuntimeConversationSurfaces(
          'local',
          host,
          () => persistence,
          () => {
            throw new Error('listener failed')
          }
        )
      ).rejects.toThrow('listener failed')
      const committed = store.conversations.surfaces.read(conversation.conversationId)!
      expect(committed.visible).toBe(false)
      expect(committed.publishedRevision).toBe(committed.surfaceRevision)
      await publishRuntimeConversationSurfaces('local', host, () => persistence, notify)
      expect(store.conversations.surfaces.read(conversation.conversationId)).toEqual(committed)
      expect(notify).toHaveBeenCalledExactlyOnceWith(worktree)
    } finally {
      setStructuredAgentSessionHost(null)
    }
  }
)

vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
