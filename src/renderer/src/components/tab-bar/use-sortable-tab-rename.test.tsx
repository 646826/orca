// @vitest-environment happy-dom

import { Fragment, StrictMode, useLayoutEffect } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { requestTerminalTabRename } from './terminal-tab-rename-request'
import { useSortableTabRename } from './use-sortable-tab-rename'

type RenameView = {
  enabled: boolean
  isEditing: boolean
  commitRename: () => void
}

function RenameEditor({
  enabled,
  onSetCustomTitle,
  onView
}: {
  enabled: boolean
  onSetCustomTitle: (tabId: string, title: string | null) => void
  onView: (view: RenameView) => void
}) {
  const rename = useSortableTabRename({
    enabled,
    tabId: 'tab',
    title: 'Runtime title',
    onSetCustomTitle
  })
  const { isEditing, commitRename } = rename
  useLayoutEffect(() => {
    onView({ enabled, isEditing, commitRename })
  }, [enabled, isEditing, commitRename, onView])
  return (
    <>
      <button onClick={rename.handleRenameOpen}>Rename</button>
      {isEditing ? (
        <input
          aria-label="Title"
          ref={rename.setRenameInputElement}
          value={rename.renameValue}
          onChange={(event) => rename.setRenameValue(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              rename.cancelRename()
            }
          }}
        />
      ) : null}
    </>
  )
}

afterEach(cleanup)

it.each([false, true])(
  'discards disabled editing before commit and refuses stale blur, then opens a fresh draft (StrictMode=%s)',
  (strict) => {
    const save = vi.fn()
    const views: RenameView[] = []
    const onView = (view: RenameView) => views.push(view)
    const view = render(<RenameEditor enabled onSetCustomTitle={save} onView={onView} />, {
      wrapper: strict ? StrictMode : Fragment
    })
    fireEvent.click(view.getByRole('button', { name: 'Rename' }))
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'Discard this draft' } })
    const staleBlur = views.at(-1)!.commitRename

    view.rerender(<RenameEditor enabled={false} onSetCustomTitle={save} onView={onView} />)
    expect(view.queryByRole('textbox')).toBeNull()
    expect(views.filter((entry) => !entry.enabled).every((entry) => !entry.isEditing)).toBe(true)
    act(staleBlur)
    fireEvent.click(view.getByRole('button', { name: 'Rename' }))
    act(() => requestTerminalTabRename('tab'))
    expect(view.queryByRole('textbox')).toBeNull()
    expect(save).not.toHaveBeenCalled()

    view.rerender(<RenameEditor enabled onSetCustomTitle={save} onView={onView} />)
    expect(view.queryByRole('textbox')).toBeNull()
    act(() => requestTerminalTabRename('tab'))
    expect(view.getByRole('textbox').getAttribute('value')).toBe('Runtime title')
    fireEvent.change(view.getByRole('textbox'), { target: { value: '  Fresh title  ' } })
    const blur = views.at(-1)!.commitRename
    fireEvent.blur(view.getByRole('textbox'))
    act(blur)
    expect(save).toHaveBeenCalledExactlyOnceWith('tab', 'Fresh title')
    expect(view.queryByRole('textbox')).toBeNull()
  }
)

it('does not save a cancelled draft when its detached input delivers a late blur', () => {
  const save = vi.fn()
  const views: RenameView[] = []
  const view = render(
    <RenameEditor enabled onSetCustomTitle={save} onView={(entry) => views.push(entry)} />,
    { wrapper: StrictMode }
  )
  fireEvent.click(view.getByRole('button', { name: 'Rename' }))
  fireEvent.change(view.getByRole('textbox'), { target: { value: 'Discard this draft' } })
  const staleBlur = views.at(-1)!.commitRename
  fireEvent.keyDown(view.getByRole('textbox'), { key: 'Escape' })
  act(staleBlur)
  expect(view.queryByRole('textbox')).toBeNull()
  expect(save).not.toHaveBeenCalled()
})
