import { describe, expect, it } from 'vitest'
import type { LificConnectionProfile } from '../../../../shared/lific/lific-types'
import {
  buildLificConnectionProfile,
  createLificIntegrationState,
  profileToLificIntegrationState,
  reduceLificIntegrationState
} from './lific-integration-state'

const HTTP_PROFILE: LificConnectionProfile = {
  id: 'profile',
  executionHostId: 'ssh:connection',
  displayName: 'Repo Lific',
  transport: {
    kind: 'http',
    baseUrl: 'https://lific.example.test',
    mcpUrl: 'https://lific.example.test/mcp'
  },
  managementAuth: { kind: 'external-key', credentialRef: 'credential' },
  executionTarget: {
    kind: 'ssh',
    id: 'ssh:connection',
    connectionId: 'connection',
    host: 'host.example.test',
    port: 2222,
    identityFile: '~/.ssh/id_ed25519'
  },
  managedByOrca: true,
  lastValidatedAt: 42,
  lastValidationState: { kind: 'ready', checkedAt: 42 }
}

describe('Lific integration state', () => {
  it('defaults the execution target from the repository host', () => {
    expect(createLificIntegrationState(false).targetMode).toBe('current')
    expect(createLificIntegrationState(true).targetMode).toBe('ssh')
  })

  it('hydrates an SSH HTTP profile into editable form state', () => {
    expect(profileToLificIntegrationState(HTTP_PROFILE)).toMatchObject({
      profile: HTTP_PROFILE,
      targetMode: 'ssh',
      sshHost: 'host.example.test',
      sshPort: '2222',
      sshIdentityFile: '~/.ssh/id_ed25519',
      mode: 'http',
      baseUrl: 'https://lific.example.test',
      mcpUrl: 'https://lific.example.test/mcp',
      health: { kind: 'ready', checkedAt: 42 }
    })
  })

  it('builds a normalized profile and preserves validation metadata', () => {
    const state = reduceLificIntegrationState(createLificIntegrationState(true), {
      profile: HTTP_PROFILE,
      targetMode: 'ssh',
      sshHost: ' host.example.test ',
      sshPort: '2222',
      sshIdentityFile: ' ~/.ssh/id_ed25519 ',
      baseUrl: ' https://lific.example.test ',
      mcpUrl: ' https://lific.example.test/mcp '
    })

    expect(
      buildLificConnectionProfile({
        state,
        profileId: 'profile',
        credentialRef: 'credential',
        executionHostId: 'local',
        repoConnectionId: 'connection',
        repoDisplayName: 'Repo'
      })
    ).toEqual(HTTP_PROFILE)
  })

  it('omits an invalid optional SSH port instead of emitting corrupt config', () => {
    const state = reduceLificIntegrationState(createLificIntegrationState(true), {
      targetMode: 'ssh',
      sshHost: 'host.example.test',
      sshPort: '70000'
    })
    const profile = buildLificConnectionProfile({
      state,
      profileId: 'profile',
      credentialRef: 'credential',
      executionHostId: 'local',
      repoConnectionId: 'connection',
      repoDisplayName: 'Repo'
    })

    expect(profile.executionTarget).toEqual({
      kind: 'ssh',
      id: 'ssh:connection',
      connectionId: 'connection',
      host: 'host.example.test'
    })
  })
})
