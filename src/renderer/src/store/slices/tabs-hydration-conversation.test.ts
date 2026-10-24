import { expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { buildHydratedTabState } from './tabs-hydration'

it('hydrates a conversation under its original visual id without a provider hint', () => {
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    unifiedTabs: {
      wt: [
        {
          id: 'stable',
          entityId: 'conversation',
          contentType: 'conversation',
          groupId: 'group',
          worktreeId: 'wt',
          label: 'History',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    tabGroups: {
      wt: [
        {
          id: 'group',
          worktreeId: 'wt',
          tabOrder: ['stable'],
          activeTabId: 'stable',
          recentTabIds: ['stable']
        }
      ]
    }
  }
  const hydrated = buildHydratedTabState(session, new Set(['wt']))
  expect(hydrated.unifiedTabsByWorktree.wt).toEqual(session.unifiedTabs!.wt)
  expect(hydrated.groupsByWorktree.wt).toEqual(session.tabGroups!.wt)
})
