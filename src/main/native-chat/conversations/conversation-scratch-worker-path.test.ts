import { expect, it } from 'vitest'
import { MAIN_BUILD_ENTRY_POINTS } from '../../../../config/build-plugins/main-build-entry-points'
import { GUARDED_ENTRY_NAMES } from '../../../../config/build-plugins/plain-node-entry-guard'
import {
  ORCAD_CHILD_ENTRY_POINTS,
  orcadChildOutputFilename
} from '../../../../config/scripts/orcad-entry-build.mjs'
import { resolveWorkerThreadEntryPath } from '../../worker-thread-entry-path'

it('packages the same electron-free scratch entry for desktop and orcad workers', () => {
  const source = ORCAD_CHILD_ENTRY_POINTS.conversationScratch
  expect(MAIN_BUILD_ENTRY_POINTS['conversation-scratch-worker-entry']).toMatch(
    /conversation-scratch-worker-entry\.ts$/
  )
  expect(orcadChildOutputFilename(source)).toBe('conversation-scratch-worker-entry.js')
  expect(GUARDED_ENTRY_NAMES).toContain('conversation-scratch-worker-entry')
  expect(
    resolveWorkerThreadEntryPath(
      { isPackaged: true, resourcesPath: '/resources', moduleDir: '/module' },
      'conversation-scratch-worker-entry.js'
    )
  ).toContain('app.asar')
  expect(
    resolveWorkerThreadEntryPath(
      { isPackaged: true, resourcesPath: undefined, moduleDir: '/module' },
      'conversation-scratch-worker-entry.js'
    )
  ).toMatch(/module[/\\]conversation-scratch-worker-entry\.js$/)
})
