// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SortableTabContextMenu } from './SortableTabContextMenu'

vi.mock('@/store', async () => ({
  useAppStore: (await import('@/store/slices/store-test-helpers')).createTestStore()
}))

afterEach(cleanup)

it('exposes the selected color and routes color selection and clearing through the existing action', () => {
  const onSetTabColor = vi.fn()
  const props = {
    tab: { id: 'terminal', worktreeId: 'workspace', color: '#3b82f6' },
    unifiedTabId: 'terminal-pane',
    groupId: 'group',
    isActive: true,
    open: true,
    point: { x: 0, y: 0 },
    tabCount: 1,
    hasTabsToRight: false,
    hasTabsToLeft: false,
    isPinned: false,
    canSplitTerminal: false,
    canSwitchSessionSurface: false,
    onOpenChange: vi.fn(),
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseToRight: vi.fn(),
    onCloseToLeft: vi.fn(),
    onRenameOpen: vi.fn(),
    onSetTabColor,
    onTogglePin: vi.fn()
  }
  const view = render(<SortableTabContextMenu {...props} />)
  expect(view.queryByRole('menuitemradio', { name: 'Blue' })?.getAttribute('aria-checked')).toBe(
    'true'
  )
  const red = view.getByRole('menuitemradio', { name: 'Red' })
  expect(red.getAttribute('aria-checked')).toBe('false')
  fireEvent.keyDown(red, { key: 'Enter' })
  expect(onSetTabColor).toHaveBeenLastCalledWith('terminal', '#ef4444')

  view.rerender(<SortableTabContextMenu {...props} tab={{ ...props.tab, color: '#ef4444' }} />)
  expect(view.getByRole('menuitemradio', { name: 'Red' }).getAttribute('aria-checked')).toBe('true')
  fireEvent.click(view.getByRole('menuitemradio', { name: 'None' }))
  expect(onSetTabColor).toHaveBeenLastCalledWith('terminal', null)
  expect(onSetTabColor).toHaveBeenCalledTimes(2)
})
