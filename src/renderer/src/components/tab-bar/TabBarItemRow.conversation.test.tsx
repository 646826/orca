// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTab, makeUnifiedTab, makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import { makeAgentStatusEntry } from '@/runtime/sync-runtime-graph-test-harness'
import {
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { TabBarItemActions } from './use-tab-bar-item-actions'
import type * as LocalRuntimeCapabilities from '@/runtime/local-runtime-capabilities'
import type * as HostStructuredAgents from '@/runtime/host-structured-agents'

vi.mock('@/store', async () => ({
  useAppStore: (await import('@/store/slices/store-test-helpers')).createTestStore()
}))
vi.mock('@/runtime/local-runtime-capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalRuntimeCapabilities>()),
  readLocalRuntimeCapabilitiesOrUnknown: () => [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
  ]
}))
vi.mock('@/runtime/host-structured-agents', async (importOriginal) => ({
  ...(await importOriginal<typeof HostStructuredAgents>()),
  readHostStructuredAgents: () => [{ agent: 'claude', capabilities: {} }]
}))
vi.mock('@/lib/renderer-app-platform', () => ({ getRendererAppPlatform: () => 'linux' }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))

import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { resolveCliChatResumeSource } from './cli-chat-resume-source'
import TabBarItemRow from './TabBarItemRow'

afterEach(cleanup)

it.each([false, true])(
  'does not offer native or CLI session operations for an aggregate with a backing-terminal ID collision (pinned: %s)',
  async (isPinned) => {
    const workspace = 'repo::/w'
    const tab = makeUnifiedTab({
      id: 'conversation-pane',
      worktreeId: workspace,
      groupId: 'group',
      entityId: 'aggregate',
      contentType: 'conversation',
      executionHostId: 'local',
      isPinned,
      agentSessionAgent: 'claude',
      label: 'Conversation'
    })
    useAppStore.setState({
      repos: [{ ...TEST_REPO, id: 'repo', path: '/w', executionHostId: 'local' }],
      worktreesByRepo: { repo: [makeWorktree({ id: workspace, repoId: 'repo', path: '/w' })] },
      unifiedTabsByWorktree: { [workspace]: [tab] },
      tabsByWorktree: { [workspace]: [makeTab({ id: tab.id, worktreeId: workspace })] },
      agentStatusByPaneKey: {
        [`${tab.id}:leaf`]: makeAgentStatusEntry({
          paneKey: `${tab.id}:leaf`,
          tabId: tab.id,
          worktreeId: workspace,
          agentType: 'claude',
          providerSession: { key: 'session_id', id: 'unrelated-cli-session' }
        })
      }
    })
    expect(resolveCliChatResumeSource(useAppStore.getState(), { tab })).toMatchObject({
      providerSessionId: 'unrelated-cli-session'
    })
    const actions: TabBarItemActions = {
      activateTerminal: vi.fn(),
      activateFile: vi.fn(),
      activateBrowserTab: vi.fn(),
      activateAgentSession: vi.fn(),
      close: vi.fn(),
      closeFile: vi.fn(),
      closeBrowserTab: vi.fn(),
      closeOthers: vi.fn(),
      closeToRight: vi.fn(),
      closeToLeft: vi.fn(),
      closeSplitPane: vi.fn(),
      closeAllFiles: vi.fn(),
      setCustomTitle: vi.fn(),
      setTabColor: vi.fn(),
      togglePaneExpand: vi.fn(),
      duplicateBrowserTab: vi.fn(),
      makePreviewFilePermanent: vi.fn(),
      togglePinned: vi.fn(),
      toggleViewMode: vi.fn()
    }
    const view = render(
      <TooltipProvider>
        <TabBarItemRow
          item={{
            type: 'conversation',
            id: tab.id,
            unifiedTabId: tab.id,
            isPinned,
            data: { ...tab, contentType: 'conversation' }
          }}
          actions={actions}
          worktreeId={workspace}
          groupId={tab.groupId}
          generatedTabTitlesEnabled={false}
          tabCount={1}
          hasTabsToLeft={false}
          hasTabsToRight={false}
          isActive
          isExpanded={false}
          dropIndicator={null}
          includeTopTabBorder
          canToggleViewMode={false}
          isChatView={false}
          viewModeTabId={undefined}
          canDuplicate={false}
          canCloseSplitPane={false}
          gitStatus={null}
        />
      </TooltipProvider>
    )
    expect(
      view.getByText('Conversation').closest('[data-tab-id]')?.getAttribute('data-pinned')
    ).toBe(String(isPinned))
    fireEvent.contextMenu(view.getByText('Conversation'))
    expect(await view.findByRole('menuitem', { name: 'Copy Tab ID' })).not.toBeNull()
    expect(view.queryByRole('menuitem', { name: /^(Pin|Unpin) Tab$/ })).toBeNull()
    expect(view.queryByRole('menuitem', { name: /Change Title/ })).toBeNull()
    expect(view.queryByText('Tab Color')).toBeNull()
    expect(
      view.queryByRole('menuitem', {
        name: /Continue in Chat UI|Continue with Terminal Agent|Resume in New/
      })
    ).toBeNull()
  }
)
