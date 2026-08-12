import { describe, expect, it } from 'vitest'
import type { MulticaConnectionProfile } from '../../shared/multica/multica-types'
import {
  MULTICA_API_BODY_MAX_BYTES,
  buildMulticaApiRequest,
  type MulticaApiRequestInput
} from './multica-api-request'

const profile: MulticaConnectionProfile = {
  id: 'multica-cloud',
  displayName: 'Multica Cloud',
  executionHostId: 'local',
  dataPlane: {
    kind: 'rest',
    serverUrl: 'https://api.multica.example',
    credentialRef: 'multica-cloud-token'
  },
  lifecycle: { kind: 'external' },
  managedByOrca: false,
  defaultWorkspaceId: 'workspace-default'
}

const token = 'mul_test_token_12345678'

describe('buildMulticaApiRequest', () => {
  it('builds a global authenticated GET without leaking the token into the URL', () => {
    const request = buildMulticaApiRequest(profile, token, {
      method: 'GET',
      endpoint: '/api/me',
      scope: { kind: 'global' },
      requestId: 'request-1'
    })

    expect(request).toEqual({
      url: 'https://api.multica.example/api/me',
      init: {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Request-ID': 'request-1'
        }
      }
    })
    expect(request.url).not.toContain(token)
  })

  it('builds a deterministic workspace request with sorted and repeated query values', () => {
    const request = buildMulticaApiRequest(profile, token, {
      method: 'GET',
      endpoint: '/api/issues',
      scope: { kind: 'workspace' },
      query: {
        status: ['in_progress', 'blocked'],
        limit: 50,
        include_closed: false,
        ignored: undefined,
        empty: null,
        search: 'login failure'
      }
    })

    expect(request.url).toBe(
      'https://api.multica.example/api/issues?include_closed=false&limit=50&search=login+failure&status=in_progress&status=blocked'
    )
    expect(request.init.headers).toEqual({
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Workspace-ID': 'workspace-default'
    })
  })

  it('supports an explicit workspace override', () => {
    const request = buildMulticaApiRequest(profile, token, {
      method: 'GET',
      endpoint: '/api/projects',
      scope: { kind: 'workspace', workspaceId: 'workspace-override' }
    })

    expect(request.init.headers).toMatchObject({
      'X-Workspace-ID': 'workspace-override'
    })
  })

  it('serializes a bounded JSON mutation and includes its idempotency key', () => {
    const request = buildMulticaApiRequest(profile, token, {
      method: 'POST',
      endpoint: '/api/issues',
      scope: { kind: 'workspace' },
      idempotencyKey: 'issue-create-1',
      body: { title: 'Fix login', priority: 'high' }
    })

    expect(request.init).toEqual({
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'issue-create-1',
        'X-Workspace-ID': 'workspace-default'
      },
      body: '{"title":"Fix login","priority":"high"}'
    })
  })

  it('rejects CLI-only profiles', () => {
    expect(() =>
      buildMulticaApiRequest(
        {
          ...profile,
          dataPlane: {
            kind: 'cli',
            executable: 'multica',
            credentialRef: 'multica-cli-token'
          }
        },
        token,
        { method: 'GET', endpoint: '/api/me', scope: { kind: 'global' } }
      )
    ).toThrow('Multica profile does not configure a REST transport')
  })

  it('requires a workspace for workspace-scoped requests', () => {
    expect(() =>
      buildMulticaApiRequest(
        { ...profile, defaultWorkspaceId: undefined },
        token,
        { method: 'GET', endpoint: '/api/issues', scope: { kind: 'workspace' } }
      )
    ).toThrow('Multica API request requires a workspace')
  })

  it.each([
    ['absolute endpoint', 'https://attacker.example/api/issues'],
    ['protocol-relative endpoint', '//attacker.example/api/issues'],
    ['path traversal', '/api/../admin'],
    ['encoded path traversal', '/api/%2e%2e/admin'],
    ['query in endpoint', '/api/issues?token=secret'],
    ['fragment in endpoint', '/api/issues#secret'],
    ['backslash in endpoint', '/api\\issues'],
    ['non-api endpoint', '/internal/issues']
  ])('rejects an unsafe %s', (_name, endpoint) => {
    expect(() =>
      buildMulticaApiRequest(profile, token, {
        method: 'GET',
        endpoint,
        scope: { kind: 'global' }
      })
    ).toThrow('Invalid Multica API endpoint')
  })

  it.each([
    ['empty token', ' '],
    ['token with control character', 'mul_secret\nvalue'],
    ['workspace with control character', 'workspace\nother'],
    ['request ID with separator', 'request:other'],
    ['idempotency key with whitespace', 'key other']
  ])('rejects an unsafe %s without echoing it', (name, value) => {
    const input: MulticaApiRequestInput = {
      method: 'POST',
      endpoint: '/api/issues',
      scope: {
        kind: 'workspace',
        workspaceId: name.startsWith('workspace') ? value : 'workspace-1'
      },
      requestId: name.startsWith('request') ? value : undefined,
      idempotencyKey: name.startsWith('idempotency') ? value : undefined,
      body: { title: 'Issue' }
    }
    const unsafeToken = name.includes('token') ? value : token

    let message = ''
    try {
      buildMulticaApiRequest(profile, unsafeToken, input)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toBeTruthy()
    const secretFragment = value.trim()
    if (secretFragment) {
      expect(message).not.toContain(secretFragment)
    }
  })

  it('rejects bodies on GET and DELETE requests', () => {
    for (const method of ['GET', 'DELETE'] as const) {
      expect(() =>
        buildMulticaApiRequest(profile, token, {
          method,
          endpoint: '/api/issues',
          scope: { kind: 'workspace' },
          body: { unsafe: true }
        })
      ).toThrow(`Multica ${method} requests cannot include a body`)
    }
  })

  it('rejects cyclic and oversized JSON bodies', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    expect(() =>
      buildMulticaApiRequest(profile, token, {
        method: 'POST',
        endpoint: '/api/issues',
        scope: { kind: 'workspace' },
        body: cyclic
      })
    ).toThrow('Multica API body is not JSON serializable')

    expect(() =>
      buildMulticaApiRequest(profile, token, {
        method: 'POST',
        endpoint: '/api/issues',
        scope: { kind: 'workspace' },
        body: { content: 'x'.repeat(MULTICA_API_BODY_MAX_BYTES) }
      })
    ).toThrow(`Multica API body exceeds ${MULTICA_API_BODY_MAX_BYTES} bytes`)
  })

  it('rejects server URLs with credentials or ambiguous path prefixes', () => {
    for (const serverUrl of [
      'https://user:pass@api.multica.example',
      'ftp://api.multica.example',
      'https://api.multica.example/base'
    ]) {
      expect(() =>
        buildMulticaApiRequest(
          {
            ...profile,
            dataPlane: { ...profile.dataPlane, serverUrl }
          },
          token,
          { method: 'GET', endpoint: '/api/me', scope: { kind: 'global' } }
        )
      ).toThrow('Invalid Multica API server URL')
    }
  })
})
