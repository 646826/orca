import { describe, expect, it } from 'vitest'
import {
  MulticaTrackerCodecError,
  parseMulticaProject,
  parseMulticaProjectList,
  parseMulticaWorkspace,
  parseMulticaWorkspaceList
} from './multica-tracker-codecs'

const workspacePayload = {
  id: 'workspace-1',
  name: 'Core Platform',
  slug: 'core-platform',
  description: 'Platform work',
  context: null,
  settings: { timezone: 'UTC' },
  repos: [
    {
      url: 'https://github.com/example/platform',
      description: 'Primary repository'
    }
  ],
  issue_prefix: 'CORE',
  avatar_url: null,
  created_at: '2026-08-12T10:00:00Z',
  updated_at: '2026-08-12T11:00:00Z',
  future_server_field: true
}

const projectPayload = {
  id: 'project-1',
  workspace_id: 'workspace-1',
  title: 'Hybrid runtime',
  description: null,
  icon: '🚀',
  status: 'in_progress',
  priority: 'high',
  lead_type: 'agent',
  lead_id: 'agent-1',
  start_date: '2026-08-12',
  due_date: '2026-08-31',
  created_at: '2026-08-12T10:00:00Z',
  updated_at: '2026-08-12T11:00:00Z',
  issue_count: 7,
  done_count: 3,
  resource_count: 2,
  future_server_field: { enabled: true }
}

describe('Multica workspace codecs', () => {
  it('normalizes the latest full workspace shape without retaining unknown fields', () => {
    expect(parseMulticaWorkspace(workspacePayload)).toEqual({
      id: 'workspace-1',
      name: 'Core Platform',
      slug: 'core-platform',
      description: 'Platform work',
      context: null,
      settings: { timezone: 'UTC' },
      repos: [
        {
          url: 'https://github.com/example/platform',
          description: 'Primary repository'
        }
      ],
      issuePrefix: 'CORE',
      avatarUrl: null,
      createdAt: '2026-08-12T10:00:00Z',
      updatedAt: '2026-08-12T11:00:00Z'
    })
  })

  it('accepts the array returned by both GET /api/workspaces and workspace list --output json', () => {
    expect(
      parseMulticaWorkspaceList([
        { id: 'workspace-1', name: 'Core Platform', slug: 'core-platform' },
        { id: 'workspace-2', name: 'Applications', slug: 'apps', ignored: true }
      ])
    ).toEqual([
      { id: 'workspace-1', name: 'Core Platform', slug: 'core-platform' },
      { id: 'workspace-2', name: 'Applications', slug: 'apps' }
    ])
  })

  it('rejects malformed repositories without echoing response content', () => {
    const secret = 'mul_response_secret'
    const error = captureError(() =>
      parseMulticaWorkspace({
        ...workspacePayload,
        repos: [{ url: secret, description: 42 }]
      })
    )

    expect(error).toBeInstanceOf(MulticaTrackerCodecError)
    expect(error.code).toBe('invalid-workspace')
    expect(error.message).not.toContain(secret)
  })
})

describe('Multica project codecs', () => {
  it('normalizes the latest project shape', () => {
    expect(parseMulticaProject(projectPayload)).toEqual({
      id: 'project-1',
      workspaceId: 'workspace-1',
      title: 'Hybrid runtime',
      description: null,
      icon: '🚀',
      status: 'in_progress',
      priority: 'high',
      leadType: 'agent',
      leadId: 'agent-1',
      startDate: '2026-08-12',
      dueDate: '2026-08-31',
      createdAt: '2026-08-12T10:00:00Z',
      updatedAt: '2026-08-12T11:00:00Z',
      issueCount: 7,
      doneCount: 3,
      resourceCount: 2
    })
  })

  it('normalizes the REST envelope and preserves its authoritative total', () => {
    expect(parseMulticaProjectList({ projects: [projectPayload], total: 9 })).toEqual({
      projects: [parseMulticaProject(projectPayload)],
      total: 9
    })
  })

  it('normalizes the project list CLI array and derives its total', () => {
    expect(parseMulticaProjectList([projectPayload])).toEqual({
      projects: [parseMulticaProject(projectPayload)],
      total: 1
    })
  })

  it('preserves unknown future status and priority strings for forward compatibility', () => {
    expect(
      parseMulticaProject({
        ...projectPayload,
        status: 'future_status',
        priority: 'future_priority'
      })
    ).toMatchObject({ status: 'future_status', priority: 'future_priority' })
  })

  it.each([
    ['negative counters', { ...projectPayload, issue_count: -1 }],
    ['invalid calendar dates', { ...projectPayload, due_date: '12/08/2026' }],
    ['invalid lead pairs', { ...projectPayload, lead_type: null, lead_id: 'agent-1' }]
  ])('rejects %s', (_name, payload) => {
    const error = captureError(() => parseMulticaProject(payload))
    expect(error.code).toBe('invalid-project')
  })

  it('rejects unbounded lists before allocating normalized results', () => {
    const payload = Array.from({ length: 10_001 }, () => projectPayload)
    const error = captureError(() => parseMulticaProjectList(payload))
    expect(error.code).toBe('invalid-project-list')
  })
})

function captureError(run: () => unknown): MulticaTrackerCodecError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(MulticaTrackerCodecError)
    return error as MulticaTrackerCodecError
  }
  throw new Error('Expected MulticaTrackerCodecError')
}
