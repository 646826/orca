import { describe, expect, it, vi } from 'vitest'
import type { MulticaProcessResult } from '../../shared/multica/multica-host-envelope'
import type { MulticaConnectionProfile } from '../../shared/multica/multica-types'
import {
  MulticaReadTransport,
  MulticaReadTransportError
} from './multica-read-transport'

function restProfile(): MulticaConnectionProfile {
  return {
    id: 'rest-profile',
    displayName: 'REST profile',
    executionHostId: 'local',
    dataPlane: {
      kind: 'rest',
      serverUrl: 'https://multica.example',
      credentialRef: 'credential/rest',
      cliFallback: { executable: 'multica', profileName: 'fallback' }
    },
    lifecycle: { kind: 'external' },
    managedByOrca: false,
    defaultWorkspaceId: 'workspace-default'
  }
}

function cliProfile(credentialRef?: string): MulticaConnectionProfile {
  return {
    id: 'cli-profile',
    displayName: 'CLI profile',
    executionHostId: 'local',
    dataPlane: {
      kind: 'cli',
      executable: 'multica',
      profileName: 'work',
      serverUrl: 'https://multica.example',
      ...(credentialRef === undefined ? {} : { credentialRef })
    },
    lifecycle: { kind: 'external' },
    managedByOrca: false,
    defaultWorkspaceId: 'workspace-default'
  }
}

function processResult(overrides: Partial<MulticaProcessResult> = {}): MulticaProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: '{"id":"issue-1"}\n',
    stderr: '',
    timedOut: false,
    truncated: false,
    ...overrides
  }
}

function validateIssue(value: unknown): { id: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('issue must be an object')
  }
  const id = (value as Record<string, unknown>).id
  if (typeof id !== 'string') {
    throw new Error('issue id is invalid')
  }
  return { id }
}

const request = {
  rest: {
    endpoint: '/api/issues/issue-1',
    options: {
      scope: { kind: 'workspace' as const, workspaceId: 'workspace-override' }
    }
  },
  cli: {
    operation: { kind: 'issue-get' as const, issueId: 'issue-1' },
    workspaceId: 'workspace-override',
    cwd: '/repo'
  },
  validate: validateIssue
}

describe('MulticaReadTransport', () => {
  it('uses REST for REST profiles and resolves the credential exactly once', async () => {
    const profile = restProfile()
    const resolveCredential = vi.fn(async () => 'mul_rest_secret')
    const executeRest = vi.fn(async () => ({ id: 'issue-1' }))
    const executeCli = vi.fn()
    const transport = new MulticaReadTransport({ resolveCredential, executeRest, executeCli })

    await expect(transport.readJson(profile, request)).resolves.toEqual({ id: 'issue-1' })

    expect(resolveCredential).toHaveBeenCalledTimes(1)
    expect(resolveCredential).toHaveBeenCalledWith('credential/rest')
    expect(executeRest).toHaveBeenCalledWith({
      profile,
      token: 'mul_rest_secret',
      endpoint: '/api/issues/issue-1',
      options: request.rest.options
    })
    expect(executeCli).not.toHaveBeenCalled()
  })

  it('uses CLI for CLI profiles and injects the resolved token only into the invocation', async () => {
    const profile = cliProfile('credential/cli')
    const resolveCredential = vi.fn(async () => 'mul_cli_secret')
    const executeRest = vi.fn()
    const executeCli = vi.fn(async () => processResult())
    const transport = new MulticaReadTransport({ resolveCredential, executeRest, executeCli })

    await expect(transport.readJson(profile, request)).resolves.toEqual({ id: 'issue-1' })

    expect(executeRest).not.toHaveBeenCalled()
    expect(executeCli).toHaveBeenCalledWith({
      profile,
      invocation: {
        command: 'multica',
        args: [
          '--server-url',
          'https://multica.example',
          '--workspace-id',
          'workspace-override',
          '--profile',
          'work',
          'issue',
          'get',
          'issue-1',
          '--output',
          'json'
        ],
        shell: false,
        env: { MULTICA_TOKEN: 'mul_cli_secret' },
        cwd: '/repo'
      }
    })
  })

  it('does not resolve or invent a credential for credential-free CLI profiles', async () => {
    const profile = cliProfile()
    const resolveCredential = vi.fn()
    const executeCli = vi.fn(async () => processResult())
    const transport = new MulticaReadTransport({
      resolveCredential,
      executeRest: vi.fn(),
      executeCli
    })

    await transport.readJson(profile, request)

    expect(resolveCredential).not.toHaveBeenCalled()
    expect(executeCli.mock.calls[0]?.[0].invocation.env).toBeUndefined()
  })

  it('does not silently fall back to CLI when a REST request fails', async () => {
    const upstream = new Error('REST unavailable')
    const executeCli = vi.fn()
    const transport = new MulticaReadTransport({
      resolveCredential: vi.fn(async () => 'mul_rest_secret'),
      executeRest: vi.fn(async () => {
        throw upstream
      }),
      executeCli
    })

    await expect(transport.readJson(restProfile(), request)).rejects.toBe(upstream)
    expect(executeCli).not.toHaveBeenCalled()
  })

  it('normalizes credential resolver failures without exposing references or secrets', async () => {
    const leaked = 'mul_super_secret_token'
    const transport = new MulticaReadTransport({
      resolveCredential: vi.fn(async () => {
        throw new Error(`vault failed for credential/rest: ${leaked}`)
      }),
      executeRest: vi.fn(),
      executeCli: vi.fn()
    })

    const error = await captureError(() => transport.readJson(restProfile(), request))

    expect(error).toBeInstanceOf(MulticaReadTransportError)
    expect(error.code).toBe('credential')
    expect(error.message).not.toContain('credential/rest')
    expect(error.message).not.toContain(leaked)
  })

  it('rejects empty resolved credentials before invoking a transport', async () => {
    const executeRest = vi.fn()
    const transport = new MulticaReadTransport({
      resolveCredential: vi.fn(async () => '  '),
      executeRest,
      executeCli: vi.fn()
    })

    const error = await captureError(() => transport.readJson(restProfile(), request))

    expect(error.code).toBe('credential')
    expect(executeRest).not.toHaveBeenCalled()
  })

  it.each(['rest', 'cli'] as const)(
    'normalizes %s validation failures without echoing response data',
    async (kind) => {
      const secret = 'mul_response_secret'
      const profile = kind === 'rest' ? restProfile() : cliProfile()
      const transport = new MulticaReadTransport({
        resolveCredential: vi.fn(async () => 'mul_transport_secret'),
        executeRest: vi.fn(async () => ({ token: secret })),
        executeCli: vi.fn(async () => processResult({ stdout: JSON.stringify({ token: secret }) }))
      })

      const error = await captureError(() =>
        transport.readJson(profile, {
          ...request,
          validate: () => {
            throw new Error(`invalid payload ${secret}`)
          }
        })
      )

      expect(error).toBeInstanceOf(MulticaReadTransportError)
      expect(error.code).toBe('invalid-data')
      expect(error.message).not.toContain(secret)
    }
  )
})

async function captureError(run: () => Promise<unknown>): Promise<MulticaReadTransportError> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(MulticaReadTransportError)
    return error as MulticaReadTransportError
  }
  throw new Error('Expected MulticaReadTransportError')
}
