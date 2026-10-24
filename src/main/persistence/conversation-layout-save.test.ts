import { expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { ConversationTabSurface } from '../native-chat/conversations/conversation-tab-surface'
import { assertConversationLayoutSave } from './conversation-layout-save'

const surface: ConversationTabSurface = {
  conversationId: 'conversation',
  sourceSessionId: 'source',
  tabId: 'visible',
  location: {
    executionHostId: 'local',
    workspaceId: 'wt',
    workspaceKind: 'folder',
    wslDistro: null
  },
  visible: true,
  surfaceRevision: 1,
  publishedRevision: 1
}
function state() {
  return {
    ...getDefaultWorkspaceSession(),
    unifiedTabs: {
      wt: [
        {
          id: 'visible',
          entityId: 'conversation',
          contentType: 'conversation' as const,
          groupId: 'group',
          worktreeId: 'wt',
          executionHostId: 'local' as const,
          label: 'Chat',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    tabGroups: {
      wt: [{ id: 'group', worktreeId: 'wt', activeTabId: 'visible', tabOrder: ['visible'] }]
    }
  }
}
it('refuses stale full-save omission or rebinding and accepts unrelated view changes', () => {
  expect(() => assertConversationLayoutSave(state(), [surface], 'local')).not.toThrow()
  expect(() =>
    assertConversationLayoutSave(getDefaultWorkspaceSession(), [surface], 'local')
  ).toThrow()
  const changed = state()
  changed.unifiedTabs.wt[0]!.entityId = 'source'
  expect(() => assertConversationLayoutSave(changed, [surface], 'local')).toThrow()
})
it('refuses hidden resurrection, broken groups, duplicate identities and foreign host bindings', () => {
  expect(() =>
    assertConversationLayoutSave(state(), [{ ...surface, visible: false }], 'local')
  ).toThrow()
  const broken = state()
  broken.tabGroups.wt[0]!.tabOrder = []
  expect(() => assertConversationLayoutSave(broken, [surface], 'local')).toThrow()
  const duplicate = state()
  duplicate.unifiedTabs.wt.push({ ...duplicate.unifiedTabs.wt[0]!, id: 'second' })
  expect(() => assertConversationLayoutSave(duplicate, [surface], 'local')).toThrow()
  expect(() => assertConversationLayoutSave(state(), [], 'local')).toThrow()
})

it('refuses a correct tab hidden under a foreign workspace map or group owner', () => {
  const misplaced = state()
  const wrongKey = {
    ...misplaced,
    unifiedTabs: { other: misplaced.unifiedTabs.wt },
    tabGroups: { other: misplaced.tabGroups.wt }
  }
  expect(() => assertConversationLayoutSave(wrongKey, [surface], 'local')).toThrow()
  const wrongGroup = state()
  wrongGroup.tabGroups.wt[0]!.worktreeId = 'other'
  expect(() => assertConversationLayoutSave(wrongGroup, [surface], 'local')).toThrow()
})
