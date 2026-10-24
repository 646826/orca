import { expect, it, vi } from 'vitest'
import { createBulkCloseSheetActions } from './mobile-bulk-close-sheet-actions'
import type { MobileSessionTab } from './mobile-session-route-types'
const conversation: MobileSessionTab = {
  type: 'conversation',
  id: 'aggregate',
  conversationId: 'c',
  title: 'Chat',
  activeSessionId: 'native',
  activeAgent: 'codex',
  contextGeneration: 1,
  activationFence: 1,
  surfaceRevision: 1,
  isActive: true
}
it('does not offer bulk retirement when the only other tab is an aggregate', () => {
  const anchor: MobileSessionTab = {
    type: 'agent-session',
    id: 'a',
    title: 'Native',
    sessionId: 'a',
    agent: 'claude',
    isActive: false
  }
  const close = vi.fn(),
    select = vi.fn()
  const actions = createBulkCloseSheetActions({
    sessionTabsRef: { current: [anchor, conversation] },
    markdownDocs: new Map(),
    activeSessionTabIdRef: { current: conversation.id },
    switchSessionTab: select,
    closeSessionTab: close
  })
  expect(actions(anchor.id, vi.fn())).toEqual([])
  expect(close).not.toHaveBeenCalled()
  expect(select).not.toHaveBeenCalled()
})
