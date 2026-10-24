import { expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../constants'
import { parseWorkspaceSession } from '../workspace-session-schema'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { saveWorkspaceLayout } from './workspace-layout-save'

it('retains conversation backing, visible id and group through schema and layout reload', () => {
  const session = {
    ...getDefaultWorkspaceSession(),
    unifiedTabs: {
      wt: [
        {
          id: 'original-tab',
          entityId: 'conversation',
          contentType: 'conversation',
          groupId: 'group',
          worktreeId: 'wt',
          executionHostId: 'local',
          label: 'History',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 7,
          isPinned: true
        }
      ]
    },
    tabGroups: {
      wt: [
        {
          id: 'group',
          worktreeId: 'wt',
          activeTabId: 'original-tab',
          tabOrder: ['original-tab'],
          recentTabIds: ['original-tab']
        }
      ]
    },
    activeTabTypeByWorktree: { wt: 'conversation' }
  }
  const parsed = parseWorkspaceSession(session)
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) {
    return
  }
  expect(parsed.value.unifiedTabs?.wt).toEqual(session.unifiedTabs.wt)
  expect(parsed.value.activeTabTypeByWorktree?.wt).toBe('conversation')
  const loaded = loadWorkspaceLayout('local', parsed.value, {
    mintId: () => 'minted',
    mintLeafId: () => 'leaf'
  })
  const saved = saveWorkspaceLayout(loaded)
  expect(saved.unifiedTabs?.wt).toEqual(session.unifiedTabs.wt)
  expect(saved.tabGroups?.wt).toEqual(session.tabGroups.wt)
})
