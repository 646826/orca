import { describe, expect, it } from 'vitest'
import {
  decodeMulticaHostEnvelope,
  type MulticaProcessInvocation,
  type MulticaProcessResult
} from '../../shared/multica/multica-host-envelope'
import type {
  MulticaConnectionProfile,
  MulticaExecutionTarget
} from '../../shared/multica/multica-types'
import {
  MulticaExecutionHostError,
  runMulticaOnExecutionHost,
  type MulticaProcessExecutor
} from './multica-execution-host'

const invocation: MulticaProcessInvocation = {
  command: 'multica',
  args: ['issue', 'list', '--output', 'json'],
  shell: false,
  env: {
    MULTICA_TOKEN: 'mul_host_secret',
    MULTICA_WORKSPACE_ID: 'workspace-1'
  },
  cwd: '/workspace/repo',
  stdin: '{"request":"body"}'
}

function profile(
  executionHostId: string,
  executionTarget?: MulticaExecutionTarget
): MulticaConnectionProfile {
  return {
    id: 'profile-1',
    displayName: 'Profile 1',
    executionHostId,
    ...(executionTarget ? { executionTarget } : {}),
    dataPlane: {
      kind: 'cli',
      executable: 'multica'
    },
    lifecycle: { kind: 'external' },
    managedByOrca: false
  }
}

function successResult(): MulticaProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: '{"ok":true}',
    stderr: '',
    timedOut: false,
    truncated: false
  }
}

function captureExecutor(): {
  execute: MulticaProcessExecutor
  invocations: MulticaProcessInvocation[]
} {
  const invocations: MulticaProcessInvocation[] = []
  return {
    invocations,
    execute: async (value) => {
      invocations.push(value)
      return successResult()
    }
  }
}

describe('runMulticaOnExecutionHost', () => {
  it('executes an owned local profile with the validated invocation unchanged', async () => {
    const local = captureExecutor()

    await expect(
      runMulticaOnExecutionHost({
        profile: profile('local'),
        invocation,
        currentHostId: 'local',
        executeLocal: local.execute
      })
    ).resolves.toEqual(successResult())

    expect(local.invocations).toEqual([invocation])
  })

  it('routes WSL through a fixed helper argv and a validated stdin envelope', async () => {
    const local = captureExecutor()
    const target: MulticaExecutionTarget = {
      kind: 'wsl',
      id: 'wsl:Ubuntu-24.04',
      distribution: 'Ubuntu-24.04',
      helperCommand: 'orca-ide'
    }

    await runMulticaOnExecutionHost({
      profile: profile(target.id, target),
      invocation,
      currentHostId: 'local',
      executeLocal: local.execute
    })

    expect(local.invocations).toHaveLength(1)
    const wrapped = requireInvocation(local.invocations[0])
    expect(wrapped).toMatchObject({
      command: 'wsl.exe',
      args: [
        '--distribution',
        'Ubuntu-24.04',
        '--cd',
        '/workspace/repo',
        '--exec',
        'orca-ide',
        'multica',
        'host-exec',
        '--envelope-stdin'
      ],
      shell: false
    })
    expect(wrapped.args).not.toContain('mul_host_secret')
    expect(decodeMulticaHostEnvelope(requireStdin(wrapped))).toEqual(invocation)
  })

  it('routes SSH through exact argv without constructing a shell command', async () => {
    const local = captureExecutor()
    const target: MulticaExecutionTarget = {
      kind: 'ssh',
      id: 'ssh:production',
      connectionId: 'connection-1',
      host: 'deploy@multica.example',
      port: 2222,
      identityFile: '/keys/multica_ed25519',
      helperCommand: 'orca-ide'
    }

    await runMulticaOnExecutionHost({
      profile: profile(target.id, target),
      invocation,
      executeLocal: local.execute
    })

    const wrapped = requireInvocation(local.invocations[0])
    expect(wrapped).toMatchObject({
      command: 'ssh',
      args: [
        '-p',
        '2222',
        '-i',
        '/keys/multica_ed25519',
        '--',
        'deploy@multica.example',
        'orca-ide',
        'multica',
        'host-exec',
        '--envelope-stdin'
      ],
      shell: false
    })
    expect(wrapped.args.join(' ')).not.toContain(invocation.command)
    expect(decodeMulticaHostEnvelope(requireStdin(wrapped))).toEqual(invocation)
  })

  it('dispatches runtime targets through the injected runtime executor', async () => {
    const local = captureExecutor()
    const runtimeCalls: Array<{
      environmentId: string
      invocation: MulticaProcessInvocation
    }> = []
    const target: MulticaExecutionTarget = {
      kind: 'runtime',
      id: 'runtime:agent-box',
      environmentId: 'environment-1'
    }

    await expect(
      runMulticaOnExecutionHost({
        profile: profile(target.id, target),
        invocation,
        executeLocal: local.execute,
        executeRuntime: async (environmentId, value) => {
          runtimeCalls.push({ environmentId, invocation: value })
          return successResult()
        }
      })
    ).resolves.toEqual(successResult())

    expect(local.invocations).toHaveLength(0)
    expect(runtimeCalls).toEqual([
      { environmentId: 'environment-1', invocation }
    ])
  })

  it('rejects an execution target ID mismatch before invoking any executor', async () => {
    const local = captureExecutor()
    const target: MulticaExecutionTarget = {
      kind: 'wsl',
      id: 'wsl:other',
      distribution: 'Ubuntu'
    }

    const error = await captureHostError(() =>
      runMulticaOnExecutionHost({
        profile: profile('wsl:expected', target),
        invocation,
        executeLocal: local.execute
      })
    )

    expect(error.code).toBe('execution-host-mismatch')
    expect(local.invocations).toHaveLength(0)
  })

  it('rejects an implicit local profile owned by another runtime', async () => {
    const local = captureExecutor()

    const error = await captureHostError(() =>
      runMulticaOnExecutionHost({
        profile: profile('host:remote'),
        invocation,
        currentHostId: 'local',
        executeLocal: local.execute
      })
    )

    expect(error.code).toBe('execution-host-mismatch')
    expect(local.invocations).toHaveLength(0)
  })

  it('requires an explicit runtime executor instead of falling back locally', async () => {
    const local = captureExecutor()
    const target: MulticaExecutionTarget = {
      kind: 'runtime',
      id: 'runtime:agent-box',
      environmentId: 'environment-1'
    }

    const error = await captureHostError(() =>
      runMulticaOnExecutionHost({
        profile: profile(target.id, target),
        invocation,
        executeLocal: local.execute
      })
    )

    expect(error.code).toBe('runtime-executor-unavailable')
    expect(local.invocations).toHaveLength(0)
  })
})

function requireInvocation(
  value: MulticaProcessInvocation | undefined
): MulticaProcessInvocation {
  if (!value) {
    throw new Error('Expected a captured Multica invocation')
  }
  return value
}

function requireStdin(value: MulticaProcessInvocation): string {
  if (value.stdin === undefined) {
    throw new Error('Expected a Multica host envelope on stdin')
  }
  return value.stdin
}

async function captureHostError(
  run: () => Promise<unknown>
): Promise<MulticaExecutionHostError> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(MulticaExecutionHostError)
    return error as MulticaExecutionHostError
  }
  throw new Error('Expected MulticaExecutionHostError')
}
