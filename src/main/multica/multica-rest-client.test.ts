import { describe, expect, it, vi } from 'vitest'
import type { MulticaConnectionProfile } from '../../shared/multica/multica-types'
import {
  MULTICA_REST_RESPONSE_MAX_BYTES,
  MulticaHttpError,
  MulticaRestClient,
  type MulticaRestClientOptions
} from './multica-rest-client'

type FetchLike = NonNullable<MulticaRestClientOptions['fetch']>

const token = 'mul_transport_secret_12345678'

const profile: MulticaConnectionProfile = {
  id: 'multica-cloud',
  displayName: 'Multica Cloud',
  executionHostId: 'local',
  dataPlane: {
    kind: 'rest',
    serverUrl: 'https://api.multica.example/',
    credentialRef: 'multica-cloud-token'
  },
  lifecycle: { kind: 'external' },
  managedByOrca: false,
  defaultWorkspaceId: 'workspace-default'
}

describe('MulticaRestClient', () => {
  it('normalizes the origin and sends authenticated Orca identity headers', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ id: 'user-1' }))
    const client = createClient(fetch)

    await expect(client.getJson('/api/me')).resolves.toEqual({ id: 'user-1' })

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://api.multica.example/api/me')
    expect(init?.method).toBe('GET')
    expect(init?.redirect).toBe('manual')
    const headers = new Headers(init?.headers)
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('Authorization')).toBe(`Bearer ${token}`)
    expect(headers.get('X-Orca-Client')).toBe('orca')
    expect(headers.get('X-Orca-Version')).toBe('test-version')
    expect(headers.has('X-Workspace-ID')).toBe(false)
  })

  it('adds the workspace header only for an explicit workspace scope', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse([]))
    const client = createClient(fetch)

    await client.getJson('/api/projects')
    await client.getJson('/api/issues', {
      scope: { kind: 'workspace' },
      query: { status: ['open', 'blocked'], limit: 25 }
    })

    const firstHeaders = new Headers(fetch.mock.calls[0][1]?.headers)
    const secondHeaders = new Headers(fetch.mock.calls[1][1]?.headers)
    expect(firstHeaders.has('X-Workspace-ID')).toBe(false)
    expect(secondHeaders.get('X-Workspace-ID')).toBe('workspace-default')
    expect(fetch.mock.calls[1][0]).toBe(
      'https://api.multica.example/api/issues?limit=25&status=open&status=blocked'
    )
  })

  it('serializes JSON mutations and forwards request identity headers', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({ id: 'issue-1' }, { status: 201 })
    )
    const client = createClient(fetch)

    await client.postJson(
      '/api/issues',
      { title: 'Fix login' },
      {
        scope: { kind: 'workspace', workspaceId: 'workspace-override' },
        requestId: 'request-1',
        idempotencyKey: 'issue-create-1'
      }
    )

    const [, init] = fetch.mock.calls[0]
    const headers = new Headers(init?.headers)
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe('{"title":"Fix login"}')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Idempotency-Key')).toBe('issue-create-1')
    expect(headers.get('X-Request-ID')).toBe('request-1')
    expect(headers.get('X-Workspace-ID')).toBe('workspace-override')
  })

  it('returns undefined for a successful 204 response', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(new Response(null, { status: 204 }))
    const client = createClient(fetch)

    await expect(
      client.deleteJson('/api/issues/issue-1', { scope: { kind: 'workspace' } })
    ).resolves.toBeUndefined()
  })

  it('decodes UTF-8 JSON up to the response byte limit', async () => {
    const payload = { label: 'готово', values: [1, 2, 3] }
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(payload))

    await expect(createClient(fetch).getJson('/api/config')).resolves.toEqual(payload)
  })

  it('rejects an oversized response before parsing it', async () => {
    const body = `"${'x'.repeat(MULTICA_REST_RESPONSE_MAX_BYTES)}"`
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      new Response(body, {
        headers: {
          'Content-Length': String(new TextEncoder().encode(body).byteLength),
          'Content-Type': 'application/json'
        }
      })
    )

    await expect(createClient(fetch).getJson('/api/config')).rejects.toThrow(
      `Multica API response exceeds ${MULTICA_REST_RESPONSE_MAX_BYTES} bytes`
    )
  })

  it('rejects invalid JSON without echoing the response body', async () => {
    const secretBody = '{"token":"mul_invalid_json_secret_12345678"'
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      new Response(secretBody, { headers: { 'Content-Type': 'application/json' } })
    )

    let message = ''
    try {
      await createClient(fetch).getJson('/api/config')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('invalid JSON')
    expect(message).not.toContain('mul_invalid_json_secret_12345678')
    expect(message).not.toContain(secretBody)
  })

  it('maps HTTP failures to bounded redacted MulticaHttpError instances', async () => {
    const responseToken = 'mul_response_secret_12345678'
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'denied',
          token: responseToken,
          authorization: `Bearer ${token}`
        }),
        {
          status: 401,
          statusText: 'Unauthorized',
          headers: { 'X-Request-ID': 'server-request-1' }
        }
      )
    )

    const error = await captureError(createClient(fetch).getJson('/api/me'))
    expect(error).toBeInstanceOf(MulticaHttpError)
    expect(error).toMatchObject({
      status: 401,
      requestId: 'server-request-1'
    })
    expect(error.message).toContain('HTTP 401')
    expect(error.message).toContain('[REDACTED]')
    expect(error.message).not.toContain(responseToken)
    expect(error.message).not.toContain(token)
  })

  it('rejects cross-origin redirects before forwarding credentials', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://attacker.example/collect' }
      })
    )

    await expect(createClient(fetch).getJson('/api/me')).rejects.toThrow(
      'Multica API redirect changed origin'
    )
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0][0])).not.toContain(token)
  })

  it('follows a bounded same-origin GET redirect with authentication intact', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        new Response(null, { status: 307, headers: { Location: '/api/v2/me' } })
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
    const client = createClient(fetch)

    await expect(client.getJson('/api/me')).resolves.toEqual({ id: 'user-1' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1][0]).toBe('https://api.multica.example/api/v2/me')
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get('Authorization')).toBe(
      `Bearer ${token}`
    )
  })

  it('retries GET on bounded transient transport failures', async () => {
    const delays: number[] = []
    const fetch = vi
      .fn<FetchLike>()
      .mockRejectedValueOnce(transientError('ECONNRESET'))
      .mockRejectedValueOnce(transientError('UND_ERR_SOCKET'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    const client = createClient(fetch, {
      retryDelaysMs: [5, 10],
      sleep: async (delayMs) => {
        delays.push(delayMs)
      }
    })

    await expect(client.getJson('/api/config')).resolves.toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(delays).toEqual([5, 10])
  })

  it('does not retry mutation transport failures', async () => {
    const fetch = vi.fn<FetchLike>().mockRejectedValue(transientError('ECONNRESET'))
    const client = createClient(fetch, { retryDelaysMs: [0, 0] })

    await expect(
      client.patchJson('/api/issues/issue-1', { title: 'Updated' }, {
        scope: { kind: 'workspace' }
      })
    ).rejects.toThrow('Multica API request failed')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('passes an abort signal and reports a bounded timeout', async () => {
    const fetch = vi.fn<FetchLike>().mockImplementation(async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
          once: true
        })
      })
    })
    const client = createClient(fetch, { timeoutMs: 1, retryDelaysMs: [] })

    await expect(client.getJson('/api/me')).rejects.toThrow(
      'Multica API request timed out after 1ms'
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

function createClient(
  fetch: FetchLike,
  overrides: Partial<MulticaRestClientOptions> = {}
): MulticaRestClient {
  return new MulticaRestClient({
    profile,
    token,
    fetch,
    clientVersion: 'test-version',
    timeoutMs: 1_000,
    retryDelaysMs: [],
    ...overrides
  })
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...Object.fromEntries(new Headers(init.headers).entries())
    }
  })
}

function transientError(code: string): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('transport failed'), { code })
  })
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('Expected promise to reject')
}
