import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyLificAgentLaunchEnv,
  LIFIC_AGENT_ENV_KEYS
} from './lific-agent-launch-context'
import { LificStateStore } from './lific-state-store'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Lific agent launch context', () => {
  it('fails closed when optional Lific state is malformed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-lific-launch-'))
    temporaryDirectories.push(directory)
    writeFileSync(join(directory, 'state.json'), '{invalid-json', 'utf8')
    const env: Record<string, string> = {
      KEEP_ME: 'yes',
      ORCA_LIFIC_PROFILE: 'stale-profile',
      ORCA_LIFIC_ISSUE: 'stale-issue',
      LIFIC_API_KEY: 'stale-secret'
    }

    expect(() =>
      applyLificAgentLaunchEnv(env, {
        worktreeId: 'repo-id::/tmp/repo',
        launchAgent: 'codex',
        executionHostId: 'local',
        state: new LificStateStore(directory)
      })
    ).not.toThrow()

    expect(env.KEEP_ME).toBe('yes')
    for (const key of LIFIC_AGENT_ENV_KEYS) {
      expect(env[key]).toBeUndefined()
    }
  })
})
