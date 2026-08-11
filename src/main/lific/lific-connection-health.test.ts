import { describe, expect, it, vi } from 'vitest'
import type {
  LificCommandRunner,
  LificConnectionProfile,
  ProcessInvocation,
  ProcessResult
} from '../../shared/lific/lific-types'
import { buildLificHealthInvocation } from './lific-commands'
import { probeLificHealth } from './lific-connection-health'

const HTTP_PROFILE: LificConnectionProfile = {
  id: 'remote',
  executionHostId: 'ssh:build',
  displayName: 'Remote Lific',
  transport: {
    kind: 'http',
    baseUrl: 'https://lific.example',
    mcpUrl: 'https://lific.example/mcp'
  },
  managementAuth: { kind: 'external-key', credentialRef: 'lific:management:remote' },
  executionTarget: {
    kind: 'ssh',
    id: 'ssh:build',
    connectionId: 'build',
    host: 'build.example'
  },
  managedByOrca: true
}

function processResult(input: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    ...input
  }
}

function runnerWith(results: ProcessResult[]): {
  runner: LificCommandRunner
  run: ReturnType<typeof vi.fn<(invocation: ProcessInvocation) => Promise<ProcessResult>>>
} {
  const run = vi.fn<(invocation: ProcessInvocation) => Promise<ProcessResult>>()
  for (const result of results) {
    run.mockResolvedValueOnce(result)
  }
  return { runner: { run }, run }
}

describe('Lific connection health', () => {
  it('builds an HTTP backend probe without placing the credential in argv', () => {
    const invocation = buildLificHealthInvocation({
      executable: 'lific',
      transport: HTTP_PROFILE.transport,
      credential: 'lific_sk-secret'
    })

    expect(invocation).toEqual({
      command: 'lific',
      args: [
        '--json',
        '--backend',
        'http',
        '--url',
        'https://lific.example',
        'project',
        'list'
      ],
      env: { LIFIC_API_KEY: 'lific_sk-secret' },
      shell: false
    })
    expect(invocation.args).not.toContain('lific_sk-secret')
  })

  it('requires configured management authentication before probing a remote profile', async () => {
    const { runner, run } = runnerWith([
      processResult({ stdout: 'lific 2.5.0\n' }),
      processResult({ stdout: '--config-only --key-env\n' })
    ])

    await expect(
      probeLificHealth({ profile: HTTP_PROFILE, executable: 'lific', runner })
    ).resolves.toEqual({ kind: 'not-configured' })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('classifies an unauthorized remote backend probe as authentication failure', async () => {
    const { runner } = runnerWith([
      processResult({ stdout: 'lific 2.5.0\n' }),
      processResult({ stdout: '--config-only --key-env\n' }),
      processResult({ exitCode: 1, stderr: '401 Unauthorized' })
    ])

    await expect(
      probeLificHealth({
        profile: HTTP_PROFILE,
        executable: 'lific',
        credential: 'lific_sk-secret',
        runner
      })
    ).resolves.toEqual({ kind: 'authentication-failed', message: '401 Unauthorized' })
  })

  it('reports a remote profile ready after the backend probe succeeds', async () => {
    const { runner, run } = runnerWith([
      processResult({ stdout: 'lific 2.5.0\n' }),
      processResult({ stdout: '--config-only --key-env\n' }),
      processResult({ stdout: '[]\n' })
    ])

    await expect(
      probeLificHealth({
        profile: HTTP_PROFILE,
        executable: 'lific',
        credential: 'lific_sk-secret',
        runner,
        now: () => 42
      })
    ).resolves.toEqual({ kind: 'ready', checkedAt: 42 })

    expect(run.mock.calls[2]?.[0]).toEqual(
      buildLificHealthInvocation({
        executable: 'lific',
        transport: HTTP_PROFILE.transport,
        credential: 'lific_sk-secret'
      })
    )
  })
})
