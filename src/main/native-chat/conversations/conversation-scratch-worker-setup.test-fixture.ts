import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, beforeEach, vi } from 'vitest'
import { join } from 'node:path'
import { buildScratchWorkerFixture } from './conversation-scratch-worker.test-fixture'

import * as workerPath from './conversation-scratch-worker-path'

const selected = { path: '' }

export function installScratchWorkerFixture() {
  let root: string
  let normal: Awaited<ReturnType<typeof buildScratchWorkerFixture>>
  let active: Awaited<ReturnType<typeof buildScratchWorkerFixture>>
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-scratch-worker-fixture-'))
    normal = await buildScratchWorkerFixture({ directory: root })
  })
  beforeEach(() => {
    active = normal
    normal.clearTrace()
    selected.path = normal.workerPath
    vi.spyOn(workerPath, 'resolveConversationScratchWorkerPath').mockImplementation(
      () => selected.path
    )
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  return {
    async fault(fault: NonNullable<Parameters<typeof buildScratchWorkerFixture>[0]['fault']>) {
      active = await buildScratchWorkerFixture({ directory: root, fault })
      selected.path = active.workerPath
    },
    reset() {
      active = normal
      selected.path = normal.workerPath
    },
    trace: () => active.trace()
  }
}
