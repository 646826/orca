import { expect, it } from 'vitest'
import type { RuntimeMobileSessionConversationTab } from '../../../src/shared/conversation-inventory'
import { mobileSessionTabsEqual } from './mobile-terminal-records'
import { resolveMobileNativeChat } from './mobile-native-chat-eligibility'
import { getMobileSessionTabTitle } from './mobile-terminal-tab-agent'
const tab: RuntimeMobileSessionConversationTab = {
  type: 'conversation',
  id: 'stable',
  conversationId: 'c',
  title: '',
  activeSessionId: 'claude-session',
  activeAgent: 'claude',
  contextGeneration: 1,
  activationFence: 1,
  surfaceRevision: 1,
  isActive: true
}
it('updates the same conversation tab for an actual agent activation and generation change', () => {
  expect(mobileSessionTabsEqual([tab], [{ ...tab }])).toBe(true)
  expect(
    mobileSessionTabsEqual(
      [tab],
      [
        {
          ...tab,
          activeSessionId: 'codex-session',
          activeAgent: 'codex' as const,
          activationFence: 2
        }
      ]
    )
  ).toBe(false)
  expect(mobileSessionTabsEqual([tab], [{ ...tab, contextGeneration: 2 }])).toBe(false)
  expect(mobileSessionTabsEqual([tab], [{ ...tab, surfaceRevision: 2 }])).toBe(false)
})
it('labels the aggregate without impersonating an editable native participant', () => {
  expect(getMobileSessionTabTitle(tab)).toBe('Conversation')
  expect(resolveMobileNativeChat(tab)).toBeNull()
})
it('preserves the prior aggregate when a census is missing or explicitly incomplete', async () => {
  const { reconcileMobileConversationInventory } = await import('./mobile-conversation-inventory')
  const incoming = {
    worktree: 'w',
    snapshotVersion: 2,
    tabs: [],
    activeTabId: null,
    activeTabType: null
  }
  expect(reconcileMobileConversationInventory(incoming, [tab]).tabs).toEqual([tab])
  expect(
    reconcileMobileConversationInventory(
      { ...incoming, conversationSurfaces: { complete: false, reason: 'resource-limit' } },
      [tab]
    ).tabs
  ).toEqual([tab])
  expect(
    reconcileMobileConversationInventory(
      { ...incoming, conversationSurfaces: { complete: true, surfaces: [] } },
      [tab]
    ).tabs
  ).toEqual([])
})

it('keeps authoritative tab ordering and refuses foreign or duplicate surface metadata', async () => {
  const { reconcileMobileConversationInventory } = await import('./mobile-conversation-inventory')
  const ordinary = {
    type: 'agent-session' as const,
    id: 'native',
    title: 'Native',
    sessionId: 'n',
    agent: 'codex' as const,
    isActive: false
  }
  const surface = {
    conversationId: 'c',
    sourceSessionId: 'a',
    tabId: 'stable',
    location: {
      executionHostId: 'local' as const,
      workspaceId: 'w',
      workspaceKind: 'folder' as const,
      wslDistro: null
    },
    visible: true,
    surfaceRevision: 1,
    publishedRevision: 1
  }
  const result = {
    worktree: 'w',
    snapshotVersion: 2,
    tabs: [tab, ordinary],
    activeTabId: 'stable',
    activeTabType: 'conversation' as const,
    conversationSurfaces: { complete: true as const, surfaces: [surface] }
  }
  expect(reconcileMobileConversationInventory(result, []).tabs.map((row) => row.id)).toEqual([
    'stable',
    'native'
  ])
  expect(
    reconcileMobileConversationInventory(
      {
        ...result,
        conversationSurfaces: {
          complete: true,
          surfaces: [{ ...surface, location: { ...surface.location, workspaceId: 'foreign' } }]
        }
      },
      []
    ).tabs
  ).toEqual([ordinary])
  expect(
    reconcileMobileConversationInventory(
      { ...result, conversationSurfaces: { complete: true, surfaces: [surface, surface] } },
      []
    ).tabs
  ).toEqual([ordinary])
})

it('rejects unsupported native agent names at the mobile inventory boundary', async () => {
  const { RuntimeMobileSessionConversationTabSchema } =
    await import('../../../src/shared/conversation-inventory')
  expect(
    RuntimeMobileSessionConversationTabSchema.safeParse({ ...tab, activeAgent: 'custom-agent' })
      .success
  ).toBe(false)
  expect(
    RuntimeMobileSessionConversationTabSchema.safeParse({ ...tab, activeAgent: 'opencode' }).success
  ).toBe(true)
})
