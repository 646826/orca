import { expect, it, vi } from 'vitest'
import { assertConversationLayoutCommand } from './conversation-layout-gate'
import { LayoutApplyParams } from '../../../../shared/rpc-contract/workspace-layout-params'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'

it('rechecks surface enrollment and requires explicit lifecycle operation even for capable callers', () => {
  const readByTab = vi.fn<AgentSessionRecordStore['conversations']['surfaces']['readByTab']>(
    () => null
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this guard only reads the declared synchronous surface lookup.
  const store = { conversations: { surfaces: { readByTab } } } as unknown as AgentSessionRecordStore
  const close: { type: 'closeTabs'; workspace: string; tabIds: [string] } = {
    type: 'closeTabs',
    workspace: 'wt',
    tabIds: ['tab']
  }
  expect(() => assertConversationLayoutCommand(store, close, false)).not.toThrow()
  readByTab.mockReturnValue({
    conversationId: 'conversation',
    sourceSessionId: 'source',
    tabId: 'tab',
    visible: true,
    surfaceRevision: 1,
    publishedRevision: 1,
    location: {
      executionHostId: 'local',
      workspaceId: 'wt',
      workspaceKind: 'folder',
      wslDistro: null
    }
  })
  expect(() => assertConversationLayoutCommand(store, close, false)).toThrow()
  expect(() => assertConversationLayoutCommand(store, close, true)).toThrow()
  const rename = {
    type: 'renameTab' as const,
    workspace: 'wt',
    tabId: 'tab',
    kind: 'custom' as const,
    title: 'Name'
  }
  expect(() => assertConversationLayoutCommand(store, rename, false)).toThrow()
  expect(() => assertConversationLayoutCommand(store, rename, true)).not.toThrow()
})
it('does not expose host-only conversation layout commands through generic RPC', () => {
  for (const type of ['promoteConversationTab', 'openConversationTab']) {
    expect(
      LayoutApplyParams.safeParse({
        command: {
          type,
          workspace: 'wt',
          tabId: 'tab',
          sourceSessionId: 'source',
          conversationId: 'conversation'
        }
      }).success
    ).toBe(false)
  }
})
