// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatAgentSwitchPicker } from './NativeChatAgentSwitchPicker'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
      fallback
    )
}))
afterEach(cleanup)
const claude = { id: 'claude-profile', label: 'Claude Code', description: 'Personal · Local' }
const codex = { id: 'codex-profile', label: 'Codex', description: 'Work · Local' }
const openCode = { id: 'opencode-profile', label: 'OpenCode', description: 'Local' }
const choices = [claude, codex, openCode]

it('selects an actual agent target without claiming it is already active', () => {
  const onSelect = vi.fn()
  const view = render(
    <NativeChatAgentSwitchPicker
      active={claude}
      selected={null}
      choices={choices}
      busy={false}
      onSelect={onSelect}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Agent Claude Code' }))
  fireEvent.click(screen.getByRole('option', { name: /Codex/ }))
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('codex-profile')
  expect(screen.getByRole('button', { name: 'Agent Claude Code' })).toBeTruthy()
  view.rerender(
    <NativeChatAgentSwitchPicker
      active={claude}
      selected={codex}
      choices={choices}
      busy={true}
      onSelect={onSelect}
    />
  )
  expect(screen.getByText('Selected: Codex')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Agent Claude Code' })).toBeTruthy()
  view.rerender(
    <NativeChatAgentSwitchPicker
      active={codex}
      selected={null}
      choices={choices}
      busy={false}
      onSelect={onSelect}
    />
  )
  expect(screen.getByRole('button', { name: 'Agent Codex' })).toBeTruthy()
  expect(screen.queryByText('Selected: Codex')).toBeNull()
})

it('keeps unavailable agents discoverable with the reason and does not dispatch them', () => {
  const onSelect = vi.fn()
  render(
    <NativeChatAgentSwitchPicker
      active={claude}
      selected={null}
      choices={[claude, { ...codex, unavailableReason: 'Update the host to use this agent.' }]}
      busy={false}
      onSelect={onSelect}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Agent Claude Code' }))
  expect(screen.getByText('Update the host to use this agent.')).toBeTruthy()
  const option = screen.getByRole('option', { name: /Codex/ })
  expect(option.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(option)
  expect(onSelect).not.toHaveBeenCalled()
})

it('opens from the keyboard and returns focus to the trigger after an unchanged visit', async () => {
  render(
    <NativeChatAgentSwitchPicker
      active={claude}
      selected={null}
      choices={choices}
      busy={false}
      onSelect={vi.fn()}
    />
  )
  const trigger = screen.getByRole('button', { name: 'Agent Claude Code' })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  const search = await screen.findByRole('combobox', { name: 'Search agents…' })
  fireEvent.keyDown(search, { key: 'Escape' })
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
})

it('does not reselect the active agent or admit another selection while switching', () => {
  const onSelect = vi.fn()
  const view = render(
    <NativeChatAgentSwitchPicker
      active={claude}
      selected={null}
      choices={choices}
      busy={false}
      onSelect={onSelect}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Agent Claude Code' }))
  fireEvent.click(screen.getByRole('option', { name: /Claude Code/ }))
  expect(onSelect).not.toHaveBeenCalled()
  view.rerender(
    <NativeChatAgentSwitchPicker
      active={claude}
      selected={codex}
      choices={choices}
      busy={true}
      onSelect={onSelect}
    />
  )
  expect(screen.getByRole('button', { name: 'Agent Claude Code' }).hasAttribute('disabled')).toBe(
    true
  )
})
