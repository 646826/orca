import { describe, expect, it } from 'vitest'
import type { MulticaConnectionProfile } from '../../shared/multica/multica-types'
import {
  buildMulticaCliInvocation,
  type MulticaCliReadOperation
} from './multica-cli-invocation'

const cliProfile: MulticaConnectionProfile = {
  id: 'multica-production',
  displayName: 'Production',
  executionHostId: 'local',
  dataPlane: {
    kind: 'cli',
    executable: '/opt/multica/bin/multica',
    profileName: 'orca-production',
    serverUrl: 'https://api.multica.example',
    credentialRef: 'multica-production-token'
  },
  lifecycle: { kind: 'external' },
  managedByOrca: false,
  defaultWorkspaceId: 'workspace-1'
}

const restProfile: MulticaConnectionProfile = {
  ...cliProfile,
  id: 'multica-rest',
  dataPlane: {
    kind: 'rest',
    serverUrl: 'https://self-hosted.example/api',
    credentialRef: 'multica-rest-token',
    cliFallback: {
      executable: 'multica',
      profileName: 'orca-self-hosted'
    }
  }
}

describe('buildMulticaCliInvocation', () => {
  it('builds a deterministic issue-list invocation with token only in the environment', () => {
    const result = buildMulticaCliInvocation(
      cliProfile,
      {
        kind: 'issue-list',
        status: 'in_progress',
        priority: 'high',
        assignee: 'Backend Agent',
        project: 'project-1',
        limit: 50,
        offset: 10,
        sort: 'updated_at:desc'
      },
      { token: 'mul_super_secret', cwd: '/workspace/repo' }
    )

    expect(result).toEqual({
      command: '/opt/multica/bin/multica',
      args: [
        '--server-url',
        'https://api.multica.example',
        '--workspace-id',
        'workspace-1',
        '--profile',
        'orca-production',
        'issue',
        'list',
        '--output',
        'json',
        '--status',
        'in_progress',
        '--priority',
        'high',
        '--assignee',
        'Backend Agent',
        '--project',
        'project-1',
        '--limit',
        '50',
        '--offset',
        '10',
        '--sort',
        'updated_at:desc'
      ],
      shell: false,
      env: { MULTICA_TOKEN: 'mul_super_secret' },
      cwd: '/workspace/repo'
    })
    expect(result.args).not.toContain('mul_super_secret')
  })

  it('uses a REST profile CLI fallback and explicit workspace override', () => {
    expect(
      buildMulticaCliInvocation(restProfile, { kind: 'project-list' }, { workspaceId: 'ws-2' })
    ).toEqual({
      command: 'multica',
      args: [
        '--server-url',
        'https://self-hosted.example/api',
        '--workspace-id',
        'ws-2',
        '--profile',
        'orca-self-hosted',
        'project',
        'list',
        '--output',
        'json'
      ],
      shell: false
    })
  })

  it.each<[MulticaCliReadOperation, string[]]>([
    [
      { kind: 'version' },
      [
        '--server-url',
        'https://api.multica.example',
        '--profile',
        'orca-production',
        'version',
        '--output',
        'json'
      ]
    ],
    [
      { kind: 'auth-status' },
      [
        '--server-url',
        'https://api.multica.example',
        '--profile',
        'orca-production',
        'auth',
        'status',
        '--output',
        'json'
      ]
    ],
    [
      { kind: 'workspace-list' },
      [
        '--server-url',
        'https://api.multica.example',
        '--profile',
        'orca-production',
        'workspace',
        'list',
        '--output',
        'json'
      ]
    ],
    [
      { kind: 'agent-list' },
      [
        '--server-url',
        'https://api.multica.example',
        '--workspace-id',
        'workspace-1',
        '--profile',
        'orca-production',
        'agent',
        'list',
        '--output',
        'json'
      ]
    ],
    [
      { kind: 'skill-list' },
      [
        '--server-url',
        'https://api.multica.example',
        '--workspace-id',
        'workspace-1',
        '--profile',
        'orca-production',
        'skill',
        'list',
        '--output',
        'json'
      ]
    ],
    [
      { kind: 'runtime-list' },
      [
        '--server-url',
        'https://api.multica.example',
        '--workspace-id',
        'workspace-1',
        '--profile',
        'orca-production',
        'runtime',
        'list',
        '--output',
        'json'
      ]
    ]
  ])('builds the %# read command without arbitrary arguments', (operation, expectedArgs) => {
    expect(buildMulticaCliInvocation(cliProfile, operation)).toEqual({
      command: '/opt/multica/bin/multica',
      args: expectedArgs,
      shell: false
    })
  })

  it('builds issue get and search invocations', () => {
    expect(buildMulticaCliInvocation(cliProfile, { kind: 'issue-get', issueId: 'MUL-123' }).args).toEqual([
      '--server-url',
      'https://api.multica.example',
      '--workspace-id',
      'workspace-1',
      '--profile',
      'orca-production',
      'issue',
      'get',
      'MUL-123',
      '--output',
      'json'
    ])
    expect(
      buildMulticaCliInvocation(cliProfile, {
        kind: 'issue-search',
        query: 'login failure',
        limit: 20,
        includeClosed: true
      }).args
    ).toEqual([
      '--server-url',
      'https://api.multica.example',
      '--workspace-id',
      'workspace-1',
      '--profile',
      'orca-production',
      'issue',
      'search',
      'login failure',
      '--output',
      'json',
      '--limit',
      '20',
      '--include-closed'
    ])
  })

  it('rejects REST profiles without a CLI fallback', () => {
    expect(() =>
      buildMulticaCliInvocation(
        {
          ...restProfile,
          dataPlane: {
            kind: 'rest',
            serverUrl: 'https://api.multica.example',
            credentialRef: 'credential-ref'
          }
        },
        { kind: 'workspace-list' }
      )
    ).toThrow('Multica profile does not configure a CLI transport')
  })

  it('requires a workspace for workspace-scoped operations', () => {
    expect(() =>
      buildMulticaCliInvocation(
        { ...cliProfile, defaultWorkspaceId: undefined },
        { kind: 'issue-list' }
      )
    ).toThrow('Multica operation issue-list requires a workspace')
  })

  it.each([
    [
      'empty executable',
      { ...cliProfile, dataPlane: { ...cliProfile.dataPlane, executable: ' ' } },
      { kind: 'version' }
    ],
    [
      'control character in identifier',
      cliProfile,
      { kind: 'issue-get', issueId: 'MUL-1\nnext' }
    ],
    ['empty search query', cliProfile, { kind: 'issue-search', query: ' ' }],
    ['invalid limit', cliProfile, { kind: 'issue-list', limit: 0 }],
    ['invalid offset', cliProfile, { kind: 'issue-list', offset: -1 }],
    ['invalid sort', cliProfile, { kind: 'issue-list', sort: 'updated;rm' }]
  ])('rejects %s', (_name, profile, operation) => {
    expect(() =>
      buildMulticaCliInvocation(
        profile as MulticaConnectionProfile,
        operation as MulticaCliReadOperation
      )
    ).toThrow()
  })
})
