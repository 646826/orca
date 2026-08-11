import { describe, expect, it } from 'vitest'
import {
  createLificTaskConsoleState,
  reduceLificTaskConsoleState
} from './lific-task-console-state'

describe('Lific task console state', () => {
  it('initializes from the preferred project without sharing mutable collections', () => {
    const first = createLificTaskConsoleState('OPS')
    const second = createLificTaskConsoleState()

    expect(first.projectIdentifier).toBe('OPS')
    expect(second.projectIdentifier).toBe('')
    expect(first.snapshot).not.toBe(second.snapshot)
    expect(first.projects).not.toBe(second.projects)
  })

  it('patches one field without dropping the rest of the console state', () => {
    const initial = createLificTaskConsoleState('OPS')
    const updated = reduceLificTaskConsoleState(initial, {
      busy: true,
      searchQuery: 'stalled'
    })

    expect(updated.busy).toBe(true)
    expect(updated.searchQuery).toBe('stalled')
    expect(updated.projectIdentifier).toBe('OPS')
    expect(updated.snapshot).toBe(initial.snapshot)
  })
})
