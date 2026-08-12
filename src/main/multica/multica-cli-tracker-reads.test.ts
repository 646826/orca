import { describe, expect, it } from 'vitest'
import type { MulticaConnectionProfile } from '../../shared/multica/multica-types'
import { buildMulticaCliInvocation } from './multica-cli-invocation'

const profile: MulticaConnectionProfile = {
  id: 'multica-production',
  displayName: 'Production',
  executionHostId: 'local',
  dataPlane: {
    kind: 'cli',
    executable: 'multica',
    profileName: 'orca-production',
    serverUrl: 'https://api.multica.example'
  },
  lifecycle: { kind: 'external' },
  managedByOrca: false,
  defaultWorkspaceId: 'workspace-default'
}

describe('Multica tracker get CLI commands', () => {
  it('gets a workspace without injecting a selected workspace flag', () => {
    expect(
      buildMulticaCliInvocation(profile, {
        kind: 'workspace-get',
        workspaceId: 'workspace-2'
      }).args
    ).toEqual([
      '--server-url',
      'https://api.multica.example',
      '--profile',
      'orca-production',
      'workspace',
      'get',
      'workspace-2',
      '--output',
      'json'
    ])
  })

  it('gets a project in an explicitly selected workspace', () => {
    expect(
      buildMulticaCliInvocation(
        profile,
        { kind: 'project-get', projectId: 'project-1' },
        { workspaceId: 'workspace-2' }
      ).args
    ).toEqual([
      '--server-url',
      'https://api.multica.example',
      '--workspace-id',
      'workspace-2',
      '--profile',
      'orca-production',
      'project',
      'get',
      'project-1',
      '--output',
      'json'
    ])
  })

  it.each([
    ['workspace', { kind: 'workspace-get' as const, workspaceId: '../workspace' }],
    ['project', { kind: 'project-get' as const, projectId: 'project/1' }]
  ])('rejects an unsafe %s identifier', (_name, operation) => {
    expect(() => buildMulticaCliInvocation(profile, operation)).toThrow()
  })

  it('requires workspace context for project get', () => {
    expect(() =>
      buildMulticaCliInvocation(
        { ...profile, defaultWorkspaceId: undefined },
        { kind: 'project-get', projectId: 'project-1' }
      )
    ).toThrow('Multica operation project-get requires a workspace')
  })
})
