import { describe, expect, it } from 'vitest'
import type { MulticaConnectionProfile } from '../../shared/multica/multica-types'
import type { MulticaJsonReadRequest } from './multica-read-transport'
import { MulticaHttpError } from './multica-rest-client'
import {
  probeMulticaHealth,
  type MulticaHealthReadJson,
  type MulticaLifecycleProbe
} from './multica-health'

type ReadCall = {
  profile: MulticaConnectionProfile
  request: MulticaJsonReadRequest<unknown>
}

function restProfile(
  options: {
    workspaceId?: string
    managed?: boolean
    cliFallback?: boolean
  } = {}
): MulticaConnectionProfile {
  return {
    id: 'rest-profile',
    displayName: 'REST profile',
    executionHostId: 'local',
    dataPlane: {
      kind: 'rest',
      serverUrl: 'https://multica.example',
      credentialRef: 'credential/rest',
      ...(options.cliFallback
        ? { cliFallback: { executable: 'multica', profileName: 'fallback' } }
        : {})
    },
    lifecycle: options.managed
      ? {
          kind: 'docker-compose',
          workingDirectory: '/srv/multica',
          composeFiles: ['compose.yml'],
          pullBeforeStart: false
        }
      : { kind: 'external' },
    managedByOrca: options.managed ?? false,
    ...(options.workspaceId === undefined
      ? {}
      : { defaultWorkspaceId: options.workspaceId })
  }
}

function cliProfile(workspaceId?: string): MulticaConnectionProfile {
  return {
    id: 'cli-profile',
    displayName: 'CLI profile',
    executionHostId: 'local',
    dataPlane: {
      kind: 'cli',
      executable: 'multica',
      profileName: 'work',
      serverUrl: 'https://multica.example',
      credentialRef: 'credential/cli'
    },
    lifecycle: { kind: 'external' },
    managedByOrca: false,
    ...(workspaceId === undefined ? {} : { defaultWorkspaceId: workspaceId })
  }
}

function createReader(
  handler: (
    profile: MulticaConnectionProfile,
    request: MulticaJsonReadRequest<unknown>
  ) => Promise<unknown> | unknown
): { readJson: MulticaHealthReadJson; calls: ReadCall[] } {
  const calls: ReadCall[] = []
  const readJson: MulticaHealthReadJson = async <T>(
    profile: MulticaConnectionProfile,
    request: MulticaJsonReadRequest<T>
  ): Promise<T> => {
    const untypedRequest = request as MulticaJsonReadRequest<unknown>
    calls.push({ profile, request: untypedRequest })
    return (await handler(profile, untypedRequest)) as T
  }
  return { readJson, calls }
}

function requestKey(
  profile: MulticaConnectionProfile,
  request: MulticaJsonReadRequest<unknown>
): string {
  return profile.dataPlane.kind === 'rest'
    ? request.rest.endpoint
    : `cli:${request.cli.operation.kind}`
}

function readyRestReader(
  extra: Partial<Record<string, unknown>> = {}
): ReturnType<typeof createReader> {
  return createReader((profile, request) => {
    const key = requestKey(profile, request)
    if (key in extra) {
      return extra[key]
    }
    switch (key) {
      case '/health':
        return { version: '2.4.0' }
      case '/api/config':
        return { version: '2.4.0', capabilities: [] }
      case '/api/me':
        return { id: 'user-1' }
      default:
        if (key.startsWith('/api/workspaces/')) {
          return { id: key.slice('/api/workspaces/'.length) }
        }
        throw new Error(`Unexpected health request ${key}`)
    }
  })
}

describe('probeMulticaHealth', () => {
  it('returns a ready external REST profile with server version and ordered capabilities', async () => {
    const profile = restProfile({ workspaceId: 'workspace-1' })
    const { readJson, calls } = readyRestReader({
      '/api/config': {
        version: '2.4.0',
        capabilities: ['skills', 'issues', 'workspaces', 'runs', 'projects', 'agents', 'comments']
      }
    })

    await expect(
      probeMulticaHealth(profile, { readJson, now: () => 1234 })
    ).resolves.toEqual({
      kind: 'ready',
      checkedAt: 1234,
      serverVersion: '2.4.0',
      capabilities: [
        'workspaces',
        'projects',
        'issues',
        'comments',
        'runs',
        'agents',
        'skills'
      ]
    })
    expect(calls.map(({ profile: callProfile, request }) => requestKey(callProfile, request))).toEqual([
      '/health',
      '/api/config',
      '/api/me',
      '/api/workspaces/workspace-1'
    ])
  })

  it('maps an invalid PAT to authentication-failed without exposing response secrets', async () => {
    const secret = 'mul_abcdefghijklmnopqrstuvwxyz0123456789'
    const { readJson } = createReader((profile, request) => {
      const key = requestKey(profile, request)
      if (key === '/api/me') {
        throw new MulticaHttpError(
          401,
          'Unauthorized',
          `Authorization: Bearer ${secret}`,
          null
        )
      }
      return key === '/health' ? { version: '2.4.0' } : { capabilities: [] }
    })

    const state = await probeMulticaHealth(restProfile(), { readJson })

    expect(state.kind).toBe('authentication-failed')
    expect(healthMessage(state)).not.toContain(secret)
  })

  it('maps a missing configured workspace to workspace-not-found', async () => {
    const profile = restProfile({ workspaceId: 'missing-workspace' })
    const { readJson } = createReader((callProfile, request) => {
      const key = requestKey(callProfile, request)
      if (key === '/api/workspaces/missing-workspace') {
        throw new MulticaHttpError(404, 'Not Found', 'missing', null)
      }
      if (key === '/health') {
        return { version: '2.4.0' }
      }
      return key === '/api/me' ? { id: 'user-1' } : { capabilities: [] }
    })

    await expect(probeMulticaHealth(profile, { readJson })).resolves.toEqual({
      kind: 'workspace-not-found',
      workspaceId: 'missing-workspace'
    })
  })

  it('maps unreachable origins to a redacted unreachable diagnostic', async () => {
    const secret = 'mul_abcdefghijklmnopqrstuvwxyz0123456789'
    const { readJson } = createReader(() => {
      throw new Error(`connect failed with MULTICA_TOKEN=${secret}`)
    })

    const state = await probeMulticaHealth(restProfile(), { readJson })

    expect(state.kind).toBe('unreachable')
    expect(healthMessage(state)).not.toContain(secret)
    expect(healthMessage(state)).not.toContain('MULTICA_TOKEN=')
  })

  it('maps CLI ENOENT to not-installed when the CLI is the required data plane', async () => {
    const error = Object.assign(new Error('spawn multica ENOENT'), { code: 'ENOENT' })
    const { readJson } = createReader(() => {
      throw error
    })

    await expect(probeMulticaHealth(cliProfile(), { readJson })).resolves.toEqual({
      kind: 'not-installed'
    })
  })

  it('keeps REST ready when an optional CLI fallback is not installed', async () => {
    const error = Object.assign(new Error('spawn multica ENOENT'), { code: 'ENOENT' })
    const { readJson } = createReader((profile, request) => {
      const key = requestKey(profile, request)
      if (key === 'cli:version') {
        throw error
      }
      if (key === '/health') {
        return { version: '2.4.0' }
      }
      return key === '/api/me' ? { id: 'user-1' } : { capabilities: [] }
    })

    const state = await probeMulticaHealth(restProfile({ cliFallback: true }), { readJson })

    expect(state).toMatchObject({ kind: 'ready', serverVersion: '2.4.0' })
    if (state.kind === 'ready') {
      expect(state.cliVersion).toBeUndefined()
    }
  })

  it('returns not-running before any data-plane request for a stopped managed service', async () => {
    const { readJson, calls } = readyRestReader()
    const probeLifecycle: MulticaLifecycleProbe = async () => ({ kind: 'not-running' })

    await expect(
      probeMulticaHealth(restProfile({ managed: true }), {
        readJson,
        probeLifecycle
      })
    ).resolves.toEqual({ kind: 'not-running' })
    expect(calls).toHaveLength(0)
  })

  it('returns compose-unavailable with a redacted lifecycle diagnostic', async () => {
    const secret = 'mul_abcdefghijklmnopqrstuvwxyz0123456789'
    const { readJson, calls } = readyRestReader()
    const probeLifecycle: MulticaLifecycleProbe = async () => ({
      kind: 'compose-unavailable',
      message: `docker failed with MULTICA_TOKEN=${secret}`
    })

    const state = await probeMulticaHealth(restProfile({ managed: true }), {
      readJson,
      probeLifecycle
    })

    expect(state.kind).toBe('compose-unavailable')
    expect(healthMessage(state)).not.toContain(secret)
    expect(calls).toHaveLength(0)
  })

  it('keeps an older server ready when optional config capability discovery is absent', async () => {
    const { readJson } = createReader((profile, request) => {
      const key = requestKey(profile, request)
      if (key === '/health') {
        return { version: '0.8.0' }
      }
      if (key === '/api/config') {
        throw new MulticaHttpError(404, 'Not Found', '', null)
      }
      if (key === '/api/me') {
        return { id: 'user-1' }
      }
      throw new Error(`Unexpected health request ${key}`)
    })

    await expect(
      probeMulticaHealth(restProfile(), { readJson, now: () => 42 })
    ).resolves.toEqual({
      kind: 'ready',
      checkedAt: 42,
      serverVersion: '0.8.0',
      capabilities: []
    })
  })

  it('advertises current server and managed lifecycle capabilities conservatively', async () => {
    const { readJson } = readyRestReader({
      '/api/config': {
        version: '3.0.0',
        capabilities: [
          'workspaces',
          'projects',
          'issues',
          'comments',
          'runs',
          'agents',
          'squads',
          'skills',
          'runtimes',
          'assignments',
          'issue-metadata',
          'realtime',
          'unknown-future-capability'
        ]
      }
    })
    const probeLifecycle: MulticaLifecycleProbe = async () => ({ kind: 'running' })

    const state = await probeMulticaHealth(restProfile({ managed: true }), {
      readJson,
      probeLifecycle,
      now: () => 99
    })

    expect(state).toEqual({
      kind: 'ready',
      checkedAt: 99,
      serverVersion: '3.0.0',
      capabilities: [
        'workspaces',
        'projects',
        'issues',
        'comments',
        'runs',
        'agents',
        'squads',
        'skills',
        'runtimes',
        'assignments',
        'issue-metadata',
        'realtime',
        'managed-lifecycle'
      ]
    })
  })

  it('probes required CLI version, authentication, and configured workspace', async () => {
    const { readJson, calls } = createReader((profile, request) => {
      switch (requestKey(profile, request)) {
        case 'cli:version':
          return { version: '1.7.2' }
        case 'cli:auth-status':
          return { authenticated: true }
        case 'cli:workspace-list':
          return { workspaces: [{ id: 'workspace-1' }] }
        default:
          throw new Error('Unexpected CLI health request')
      }
    })

    await expect(
      probeMulticaHealth(cliProfile('workspace-1'), { readJson, now: () => 7 })
    ).resolves.toEqual({
      kind: 'ready',
      checkedAt: 7,
      cliVersion: '1.7.2',
      capabilities: ['workspaces']
    })
    expect(calls.map(({ profile, request }) => requestKey(profile, request))).toEqual([
      'cli:version',
      'cli:auth-status',
      'cli:workspace-list'
    ])
  })
})

function healthMessage(state: Awaited<ReturnType<typeof probeMulticaHealth>>): string {
  if ('message' in state) {
    return state.message
  }
  throw new Error(`Expected health state with a message, got ${state.kind}`)
}
