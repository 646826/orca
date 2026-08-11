import type {
  LificConnectionProfile,
  LificHealthState
} from '../../../../shared/lific/lific-types'
export type Mode = 'http' | 'stdio'
export type ExecutionTargetMode = 'current' | 'wsl' | 'ssh'

export type LificIntegrationState = {
  mode: Mode
  targetMode: ExecutionTargetMode
  wslDistribution: string
  sshHost: string
  sshPort: string
  sshIdentityFile: string
  baseUrl: string
  mcpUrl: string
  databasePath: string
  projectIdentifier: string
  agent: string
  scope: 'global' | 'project'
  authentication: 'bot' | 'oauth'
  managementCredential: string
  profile: LificConnectionProfile | null
  health: LificHealthState | null
  preview: string
  busy: boolean
}

export function createLificIntegrationState(hasSshConnection: boolean): LificIntegrationState {
  return {
    mode: 'http',
    targetMode: hasSshConnection ? 'ssh' : 'current',
    wslDistribution: 'Ubuntu',
    sshHost: '',
    sshPort: '',
    sshIdentityFile: '',
    baseUrl: 'http://127.0.0.1:3456',
    mcpUrl: 'http://127.0.0.1:3456/mcp',
    databasePath: '~/.local/share/lific/lific.db',
    projectIdentifier: '',
    agent: 'codex',
    scope: 'global',
    authentication: 'bot',
    managementCredential: '',
    profile: null,
    health: null,
    preview: '',
    busy: false
  }
}

export function reduceLificIntegrationState(
  state: LificIntegrationState,
  patch: Partial<LificIntegrationState>
): LificIntegrationState {
  return { ...state, ...patch }
}

export function profileToLificIntegrationState(
  profile: LificConnectionProfile
): Partial<LificIntegrationState> {
  const executionPatch: Partial<LificIntegrationState> =
    profile.executionTarget?.kind === 'wsl'
      ? {
          targetMode: 'wsl',
          wslDistribution: profile.executionTarget.distribution
        }
      : profile.executionTarget?.kind === 'ssh'
        ? {
            targetMode: 'ssh',
            sshHost: profile.executionTarget.host,
            sshPort: profile.executionTarget.port ? String(profile.executionTarget.port) : '',
            sshIdentityFile: profile.executionTarget.identityFile ?? ''
          }
        : { targetMode: 'current' }
  const transportPatch: Partial<LificIntegrationState> =
    profile.transport.kind === 'http'
      ? {
          mode: 'http',
          baseUrl: profile.transport.baseUrl,
          mcpUrl: profile.transport.mcpUrl
        }
      : {
          mode: 'stdio',
          databasePath: profile.transport.databasePath
        }
  return {
    profile,
    health: profile.lastValidationState ?? null,
    ...executionPatch,
    ...transportPatch
  }
}

type DraftInput = {
  state: LificIntegrationState
  profileId: string
  credentialRef: string
  executionHostId: string
  repoConnectionId?: string | null | undefined
  repoDisplayName: string
}

export function buildLificConnectionProfile({
  state,
  profileId,
  credentialRef,
  executionHostId,
  repoConnectionId,
  repoDisplayName
}: DraftInput): LificConnectionProfile {
  const normalizedWsl = state.wslDistribution.trim() || 'default'
  const normalizedSshHost = state.sshHost.trim()
  const targetHostId =
    state.targetMode === 'wsl'
      ? `wsl:${normalizedWsl}`
      : state.targetMode === 'ssh'
        ? `ssh:${repoConnectionId ?? normalizedSshHost}`
        : executionHostId
  const parsedSshPortCandidate = state.sshPort.trim() ? Number(state.sshPort) : undefined
  const parsedSshPort =
    parsedSshPortCandidate !== undefined &&
    Number.isInteger(parsedSshPortCandidate) &&
    parsedSshPortCandidate >= 1 &&
    parsedSshPortCandidate <= 65535
      ? parsedSshPortCandidate
      : undefined
  return {
    id: profileId,
    executionHostId: targetHostId,
    displayName: `${repoDisplayName} Lific`,
    transport:
      state.mode === 'http'
        ? { kind: 'http', baseUrl: state.baseUrl.trim(), mcpUrl: state.mcpUrl.trim() }
        : { kind: 'stdio', databasePath: state.databasePath.trim() },
    managementAuth:
      state.mode === 'http' ? { kind: 'external-key', credentialRef } : { kind: 'local-instance' },
    executionTarget:
      state.targetMode === 'wsl'
        ? { kind: 'wsl', id: targetHostId, distribution: normalizedWsl }
        : state.targetMode === 'ssh'
          ? {
              kind: 'ssh',
              id: targetHostId,
              connectionId: repoConnectionId ?? targetHostId,
              host: normalizedSshHost,
              ...(parsedSshPort ? { port: parsedSshPort } : {}),
              ...(state.sshIdentityFile.trim()
                ? { identityFile: state.sshIdentityFile.trim() }
                : {})
            }
          : { kind: 'local', id: targetHostId },
    managedByOrca: true,
    ...(state.profile?.lastValidatedAt !== undefined
      ? { lastValidatedAt: state.profile.lastValidatedAt }
      : {}),
    ...(state.profile?.lastValidationState
      ? { lastValidationState: state.profile.lastValidationState }
      : {})
  }
}
