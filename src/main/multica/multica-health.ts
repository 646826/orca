import type {
  MulticaCapability,
  MulticaConnectionProfile,
  MulticaHealthState
} from '../../shared/multica/multica-types'
import type { MulticaCliReadOperation } from './multica-cli-invocation'
import {
  MulticaReadTransportError,
  type MulticaJsonReadRequest
} from './multica-read-transport'
import { MulticaHttpError } from './multica-rest-client'
import {
  collectMulticaCapabilities,
  extractMulticaIdentifier,
  extractMulticaVersion,
  extractMulticaWorkspaceIds,
  isMulticaExplicitlyUnauthenticated,
  isMulticaRecord,
  multicaHealthDiagnostic,
  orderMulticaCapabilities,
  redactMulticaHealthMessage
} from './multica-health-values'

export type MulticaHealthReadJson = <T>(
  profile: MulticaConnectionProfile,
  request: MulticaJsonReadRequest<T>
) => Promise<T>

export type MulticaLifecycleProbeResult =
  | { kind: 'running' }
  | { kind: 'not-running' }
  | { kind: 'compose-unavailable'; message: string }

export type MulticaLifecycleProbe = (
  profile: MulticaConnectionProfile
) => Promise<MulticaLifecycleProbeResult>

export type MulticaHealthProbeOptions = {
  readJson: MulticaHealthReadJson
  probeLifecycle?: MulticaLifecycleProbe
  now?: () => number
}

export async function probeMulticaHealth(
  profile: MulticaConnectionProfile,
  options: MulticaHealthProbeOptions
): Promise<MulticaHealthState> {
  const managedFailure = await probeManagedLifecycle(profile, options.probeLifecycle)
  if (managedFailure) {
    return managedFailure
  }
  return profile.dataPlane.kind === 'rest'
    ? await probeRestHealth(profile, options)
    : await probeCliHealth(profile, options)
}

async function probeManagedLifecycle(
  profile: MulticaConnectionProfile,
  probeLifecycle: MulticaLifecycleProbe | undefined
): Promise<MulticaHealthState | undefined> {
  if (!profile.managedByOrca || profile.lifecycle.kind !== 'docker-compose') {
    return undefined
  }
  if (!probeLifecycle) {
    return {
      kind: 'compose-unavailable',
      message: 'Docker Compose health probe is unavailable'
    }
  }
  try {
    const result = await probeLifecycle(profile)
    if (result.kind === 'running') {
      return undefined
    }
    if (result.kind === 'not-running') {
      return { kind: 'not-running' }
    }
    return {
      kind: 'compose-unavailable',
      message: redactMulticaHealthMessage(
        result.message,
        'Docker Compose is unavailable'
      )
    }
  } catch (error) {
    return {
      kind: 'compose-unavailable',
      message: multicaHealthDiagnostic(error, 'Docker Compose is unavailable')
    }
  }
}

async function probeRestHealth(
  profile: MulticaConnectionProfile,
  options: MulticaHealthProbeOptions
): Promise<MulticaHealthState> {
  let healthPayload: unknown
  try {
    healthPayload = await read(options, profile, '/health', { kind: 'version' })
  } catch (error) {
    return unreachable(error)
  }

  let configPayload: unknown
  try {
    configPayload = await read(options, profile, '/api/config', { kind: 'version' })
  } catch (error) {
    if (!isHttpStatus(error, 404)) {
      return authenticationOrUnreachable(error)
    }
  }

  try {
    const authPayload = await read(options, profile, '/api/me', {
      kind: 'auth-status'
    })
    if (isMulticaExplicitlyUnauthenticated(authPayload)) {
      return authenticationFailed()
    }
  } catch (error) {
    return authenticationOrUnreachable(error)
  }

  const workspaceFailure = await probeRestWorkspace(profile, options)
  if (workspaceFailure) {
    return workspaceFailure
  }

  const serverVersion =
    extractMulticaVersion(configPayload, ['version', 'serverVersion']) ??
    extractMulticaVersion(healthPayload, ['version', 'serverVersion'])
  return readyState(options, {
    serverVersion,
    cliVersion: await probeOptionalCliVersion(profile, options),
    capabilities: collectMulticaCapabilities(
      configPayload,
      profile.managedByOrca && profile.lifecycle.kind === 'docker-compose'
    )
  })
}

async function probeRestWorkspace(
  profile: MulticaConnectionProfile,
  options: MulticaHealthProbeOptions
): Promise<MulticaHealthState | undefined> {
  const workspaceId = profile.defaultWorkspaceId
  if (!workspaceId) {
    return undefined
  }

  let payload: unknown
  try {
    payload = await read(
      options,
      profile,
      `/api/workspaces/${encodeURIComponent(workspaceId)}`,
      { kind: 'workspace-list' },
      { scope: { kind: 'workspace', workspaceId } }
    )
  } catch (error) {
    if (isHttpStatus(error, 404)) {
      return { kind: 'workspace-not-found', workspaceId }
    }
    return authenticationOrUnreachable(error)
  }

  const returnedId = extractMulticaIdentifier(payload)
  return returnedId && returnedId !== workspaceId
    ? { kind: 'workspace-not-found', workspaceId }
    : undefined
}

async function probeOptionalCliVersion(
  profile: MulticaConnectionProfile,
  options: MulticaHealthProbeOptions
): Promise<string | undefined> {
  if (profile.dataPlane.kind !== 'rest' || !profile.dataPlane.cliFallback) {
    return undefined
  }
  const fallback = profile.dataPlane.cliFallback
  const cliProfile: MulticaConnectionProfile = {
    ...profile,
    dataPlane: {
      kind: 'cli',
      executable: fallback.executable,
      serverUrl: profile.dataPlane.serverUrl,
      ...(fallback.profileName === undefined
        ? {}
        : { profileName: fallback.profileName })
    }
  }
  try {
    const payload = await read(options, cliProfile, '/health', { kind: 'version' })
    return extractMulticaVersion(payload, ['version', 'cliVersion'])
  } catch {
    return undefined
  }
}

async function probeCliHealth(
  profile: MulticaConnectionProfile,
  options: MulticaHealthProbeOptions
): Promise<MulticaHealthState> {
  let versionPayload: unknown
  try {
    versionPayload = await read(options, profile, '/health', { kind: 'version' })
  } catch (error) {
    return isEnoent(error) ? { kind: 'not-installed' } : unreachable(error)
  }

  let authPayload: unknown
  try {
    authPayload = await read(options, profile, '/api/me', { kind: 'auth-status' })
  } catch (error) {
    return isEnoent(error) ? { kind: 'not-installed' } : authenticationFailed()
  }
  if (isMulticaExplicitlyUnauthenticated(authPayload)) {
    return authenticationFailed()
  }

  const capabilities: MulticaCapability[] = []
  const workspaceId = profile.defaultWorkspaceId
  if (workspaceId) {
    let workspacePayload: unknown
    try {
      workspacePayload = await read(
        options,
        profile,
        '/api/workspaces',
        { kind: 'workspace-list' }
      )
    } catch (error) {
      return isEnoent(error)
        ? { kind: 'not-installed' }
        : authenticationOrUnreachable(error)
    }
    if (!extractMulticaWorkspaceIds(workspacePayload).includes(workspaceId)) {
      return { kind: 'workspace-not-found', workspaceId }
    }
    capabilities.push('workspaces')
  }

  return readyState(options, {
    serverVersion: undefined,
    cliVersion: extractMulticaVersion(versionPayload, ['version', 'cliVersion']),
    capabilities
  })
}

async function read(
  options: MulticaHealthProbeOptions,
  profile: MulticaConnectionProfile,
  endpoint: string,
  operation: MulticaCliReadOperation,
  restOptions?: MulticaJsonReadRequest<unknown>['rest']['options']
): Promise<unknown> {
  return await options.readJson(profile, {
    rest: {
      endpoint,
      ...(restOptions ? { options: restOptions } : {})
    },
    cli: { operation },
    validate: (value) => value
  })
}

function readyState(
  options: MulticaHealthProbeOptions,
  input: {
    serverVersion: string | undefined
    cliVersion: string | undefined
    capabilities: MulticaCapability[]
  }
): MulticaHealthState {
  return {
    kind: 'ready',
    checkedAt: (options.now ?? Date.now)(),
    ...(input.serverVersion ? { serverVersion: input.serverVersion } : {}),
    ...(input.cliVersion ? { cliVersion: input.cliVersion } : {}),
    capabilities: orderMulticaCapabilities(input.capabilities)
  }
}

function authenticationOrUnreachable(error: unknown): MulticaHealthState {
  return isAuthenticationError(error) ? authenticationFailed() : unreachable(error)
}

function authenticationFailed(): MulticaHealthState {
  return {
    kind: 'authentication-failed',
    message: 'Multica authentication failed'
  }
}

function unreachable(error: unknown): MulticaHealthState {
  return {
    kind: 'unreachable',
    message: multicaHealthDiagnostic(error, 'Unable to reach Multica')
  }
}

function isAuthenticationError(error: unknown): boolean {
  return (
    (error instanceof MulticaHttpError && (error.status === 401 || error.status === 403)) ||
    (error instanceof MulticaReadTransportError && error.code === 'credential')
  )
}

function isHttpStatus(error: unknown, status: number): boolean {
  return error instanceof MulticaHttpError && error.status === status
}

function isEnoent(error: unknown): boolean {
  return isMulticaRecord(error) && error.code === 'ENOENT'
}
