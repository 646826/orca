import { expect, it } from 'vitest'
import {
  readWorkspaceWatchObservation,
  recordWorkspaceWatchEvents,
  compareWorkspaceWatchObservation
} from './workspace-watch-observation'

it('records scoped changes without treating initial state as drift or claiming exclusivity', () => {
  const root = { rootPath: '/fixture-root' }
  const other = { rootPath: '/other-root' }
  recordWorkspaceWatchEvents(root, false)
  const captured = readWorkspaceWatchObservation(root, 'host-a:folder')
  expect(compareWorkspaceWatchObservation(captured, captured)).toBe('no-change-observed')
  recordWorkspaceWatchEvents(other, false)
  expect(
    compareWorkspaceWatchObservation(captured, readWorkspaceWatchObservation(root, 'host-a:folder'))
  ).toBe('no-change-observed')
  recordWorkspaceWatchEvents(root, false)
  expect(
    compareWorkspaceWatchObservation(captured, readWorkspaceWatchObservation(root, 'host-a:folder'))
  ).toBe('observed-change')
})
it('keeps missing, interrupted and replaced watcher continuity unknown', () => {
  const root = { rootPath: '/fixture-root' }
  const captured = readWorkspaceWatchObservation(root, 'a')
  expect(compareWorkspaceWatchObservation(captured, readWorkspaceWatchObservation(null, 'a'))).toBe(
    'unknown'
  )
  expect(
    compareWorkspaceWatchObservation(
      captured,
      readWorkspaceWatchObservation({ rootPath: '/fixture-root' }, 'a')
    )
  ).toBe('unknown')
  expect(compareWorkspaceWatchObservation(captured, readWorkspaceWatchObservation(root, 'b'))).toBe(
    'unknown'
  )
  recordWorkspaceWatchEvents(root, true)
  expect(compareWorkspaceWatchObservation(captured, readWorkspaceWatchObservation(root, 'a'))).toBe(
    'unknown'
  )
  recordWorkspaceWatchEvents(root, false)
  expect(compareWorkspaceWatchObservation(captured, readWorkspaceWatchObservation(root, 'a'))).toBe(
    'unknown'
  )
  expect(
    compareWorkspaceWatchObservation(
      readWorkspaceWatchObservation(null, 'a'),
      readWorkspaceWatchObservation(null, 'a')
    )
  ).toBe('unknown')
})
