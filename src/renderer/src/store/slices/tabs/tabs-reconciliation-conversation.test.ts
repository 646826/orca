import { describe, expect, it, vi } from 'vitest'
import { createTestStore, makeUnifiedTab } from '../store-test-helpers'
import { createTabsSliceMockApi } from '../tabs-slice-test-harness'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

createTabsSliceMockApi()

describe.each(['repo1::/tmp/feature', 'folder:folder-1'])(
  'conversation reconciliation in %s',
  (worktreeId) => {
    it.each(['local', 'runtime:paired'] as const)(
      'keeps the %s conversation renderable through single and batched reconciliation',
      (executionHostId) => {
        for (const batched of [false, true]) {
          const store = createTestStore()
          const tab = makeUnifiedTab({
            id: 'conversation-pane',
            entityId: 'conversation-1',
            contentType: 'conversation',
            executionHostId,
            groupId: 'chat-group',
            worktreeId
          })
          store.setState({
            unifiedTabsByWorktree: { [worktreeId]: [tab] },
            groupsByWorktree: {
              [worktreeId]: [
                {
                  id: tab.groupId,
                  worktreeId,
                  tabOrder: [tab.id],
                  activeTabId: tab.id
                }
              ]
            },
            activeGroupIdByWorktree: { [worktreeId]: tab.groupId },
            layoutByWorktree: { [worktreeId]: { type: 'leaf', groupId: tab.groupId } }
          })
          const before = store.getState()

          if (batched) {
            store.getState().reconcileWorktreeTabModels([worktreeId])
          } else {
            expect(store.getState().reconcileWorktreeTabModel(worktreeId)).toEqual({
              renderableTabCount: 1,
              activeRenderableTabId: tab.id
            })
          }

          expect(store.getState().unifiedTabsByWorktree[worktreeId]).toEqual([tab])
          expect(store.getState().groupsByWorktree).toEqual(before.groupsByWorktree)
          expect(store.getState().activeGroupIdByWorktree).toEqual(before.activeGroupIdByWorktree)
          expect(store.getState().layoutByWorktree).toEqual(before.layoutByWorktree)
        }
      }
    )
  }
)
