import type { MulticaConnectionProfile } from '../../shared/multica/multica-types'
import {
  buildMulticaApiRequest,
  type MulticaApiMethod,
  type MulticaApiRequestInput
} from './multica-api-request'
import {
  createMulticaError,
  formatMulticaDiagnostic,
  parseMulticaJsonResponse
} from './multica-rest-response'

export {
  MULTICA_REST_RESPONSE_MAX_BYTES,
  MulticaHttpError
} from './multica-rest-response'

const TRANSPORT_ERROR_DETAIL_MAX_CHARS = 1024
const CLIENT_VERSION_MAX_CHARS = 128
const MAX_REDIRECTS = 3
const MAX_RETRY_DELAYS = 5
const MAX_RETRY_DELAY_MS = 60_000
const MAX_TIMEOUT_MS = 5 * 60_000
const TRANSIENT_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ERR_HTTP2_STREAM_ERROR',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET'
])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export type MulticaFetch = typeof globalThis.fetch

export type MulticaRestClientOptions = {
  profile: MulticaConnectionProfile
  token: string
  fetch?: MulticaFetch
  clientVersion?: string
  timeoutMs?: number
  retryDelaysMs?: readonly number[]
  sleep?: (delayMs: number) => Promise<void>
}

export type MulticaRestRequestOptions = {
  scope?: MulticaApiRequestInput['scope']
  query?: MulticaApiRequestInput['query']
  requestId?: string
  idempotencyKey?: string
  signal?: AbortSignal
}

export class MulticaRestClient {
  private readonly profile: MulticaConnectionProfile
  private readonly token: string
  private readonly fetchImpl: MulticaFetch
  private readonly clientVersion: string
  private readonly timeoutMs: number
  private readonly retryDelaysMs: readonly number[]
  private readonly sleep: (delayMs: number) => Promise<void>

  constructor(options: MulticaRestClientOptions) {
    this.profile = options.profile
    this.token = options.token
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.clientVersion = requireClientVersion(options.clientVersion ?? 'unknown')
    this.timeoutMs = requireTimeout(options.timeoutMs ?? 30_000)
    this.retryDelaysMs = requireRetryDelays(options.retryDelaysMs ?? [100, 300])
    this.sleep = options.sleep ?? defaultSleep
  }

  getJson<T = unknown>(
    endpoint: string,
    options: MulticaRestRequestOptions = {}
  ): Promise<T | undefined> {
    return this.requestJson<T>('GET', endpoint, undefined, options)
  }

  postJson<T = unknown>(
    endpoint: string,
    body: unknown,
    options: MulticaRestRequestOptions = {}
  ): Promise<T | undefined> {
    return this.requestJson<T>('POST', endpoint, body, options)
  }

  patchJson<T = unknown>(
    endpoint: string,
    body: unknown,
    options: MulticaRestRequestOptions = {}
  ): Promise<T | undefined> {
    return this.requestJson<T>('PATCH', endpoint, body, options)
  }

  putJson<T = unknown>(
    endpoint: string,
    body: unknown,
    options: MulticaRestRequestOptions = {}
  ): Promise<T | undefined> {
    return this.requestJson<T>('PUT', endpoint, body, options)
  }

  deleteJson<T = unknown>(
    endpoint: string,
    options: MulticaRestRequestOptions = {}
  ): Promise<T | undefined> {
    return this.requestJson<T>('DELETE', endpoint, undefined, options)
  }

  private async requestJson<T>(
    method: MulticaApiMethod,
    endpoint: string,
    body: unknown,
    options: MulticaRestRequestOptions
  ): Promise<T | undefined> {
    const request = buildMulticaApiRequest(this.profile, this.token, {
      method,
      endpoint,
      scope: options.scope ?? { kind: 'global' },
      query: options.query,
      body,
      requestId: options.requestId,
      idempotencyKey: options.idempotencyKey
    })
    const response = await this.fetchWithPolicy(
      request.url,
      {
        ...request.init,
        headers: {
          ...request.init.headers,
          'X-Orca-Client': 'orca',
          'X-Orca-Version': this.clientVersion
        },
        redirect: 'manual'
      },
      options.signal
    )
    return await parseMulticaJsonResponse<T>(response)
  }

  private async fetchWithPolicy(
    url: string,
    init: RequestInit,
    externalSignal: AbortSignal | undefined
  ): Promise<Response> {
    const method = init.method ?? 'GET'

    for (let attempt = 0; ; attempt += 1) {
      if (externalSignal?.aborted) {
        throw abortedError()
      }

      const attemptSignal = createAttemptSignal(this.timeoutMs, externalSignal)
      try {
        return await this.fetchRedirectChain(url, init, attemptSignal.signal)
      } catch (error) {
        if (externalSignal?.aborted) {
          throw abortedError()
        }

        const retryDelay = method === 'GET' ? this.retryDelaysMs[attempt] : undefined
        const transient = attemptSignal.didTimeout() || isTransientTransportError(error)
        if (retryDelay !== undefined && transient) {
          await this.sleep(retryDelay)
          continue
        }
        if (attemptSignal.didTimeout()) {
          throw createMulticaError(
            'MulticaTimeoutError',
            `Multica API request timed out after ${this.timeoutMs}ms`
          )
        }
        throw mapTransportError(error)
      } finally {
        attemptSignal.cleanup()
      }
    }
  }

  private async fetchRedirectChain(
    initialUrl: string,
    init: RequestInit,
    signal: AbortSignal
  ): Promise<Response> {
    const pinnedOrigin = new URL(initialUrl).origin
    let currentUrl = initialUrl

    for (let redirectCount = 0; ; redirectCount += 1) {
      const response = await this.fetchImpl(currentUrl, { ...init, signal, redirect: 'manual' })
      assertResponseOrigin(response, pinnedOrigin)

      if (!REDIRECT_STATUSES.has(response.status)) {
        return response
      }

      const location = response.headers.get('location')
      if (!location) {
        return response
      }
      if (redirectCount >= MAX_REDIRECTS) {
        throw createMulticaError(
          'MulticaRedirectError',
          'Multica API redirect limit exceeded'
        )
      }

      const nextUrl = resolveRedirectUrl(location, currentUrl)
      if (nextUrl.origin !== pinnedOrigin) {
        throw createMulticaError(
          'MulticaRedirectError',
          'Multica API redirect changed origin'
        )
      }
      if ((init.method ?? 'GET') !== 'GET' && response.status !== 307 && response.status !== 308) {
        throw createMulticaError(
          'MulticaRedirectError',
          'Multica API mutation redirect is not supported'
        )
      }
      currentUrl = nextUrl.toString()
    }
  }
}

function createAttemptSignal(timeoutMs: number, externalSignal: AbortSignal | undefined): {
  signal: AbortSignal
  didTimeout: () => boolean
  cleanup: () => void
} {
  const controller = new AbortController()
  let timedOut = false
  const onExternalAbort = (): void => {
    controller.abort(externalSignal?.reason)
  }

  if (externalSignal?.aborted) {
    controller.abort(externalSignal.reason)
  } else {
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
  }

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(createMulticaError('TimeoutError', `Timed out after ${timeoutMs}ms`))
  }, timeoutMs)

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    }
  }
}

function resolveRedirectUrl(location: string, currentUrl: string): URL {
  try {
    return new URL(location, currentUrl)
  } catch {
    throw createMulticaError(
      'MulticaRedirectError',
      'Multica API redirect URL is invalid'
    )
  }
}

function assertResponseOrigin(response: Response, pinnedOrigin: string): void {
  if (!response.url) {
    return
  }
  let responseOrigin: string
  try {
    responseOrigin = new URL(response.url).origin
  } catch {
    throw createMulticaError(
      'MulticaRedirectError',
      'Multica API response URL is invalid'
    )
  }
  if (responseOrigin !== pinnedOrigin) {
    throw createMulticaError(
      'MulticaRedirectError',
      'Multica API redirect changed origin'
    )
  }
}

function requireClientVersion(value: string): string {
  if (!value.trim() || value !== value.trim() || value.length > CLIENT_VERSION_MAX_CHARS) {
    throw new Error('Invalid Orca client version')
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127) {
      throw new Error('Invalid Orca client version')
    }
  }
  return value
}

function requireTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new Error('Multica REST timeout is invalid')
  }
  return value
}

function requireRetryDelays(values: readonly number[]): readonly number[] {
  if (values.length > MAX_RETRY_DELAYS) {
    throw new Error('Multica REST retry policy is invalid')
  }
  if (
    values.some(
      (value) =>
        !Number.isSafeInteger(value) || value < 0 || value > MAX_RETRY_DELAY_MS
    )
  ) {
    throw new Error('Multica REST retry policy is invalid')
  }
  return [...values]
}

function isTransientTransportError(error: unknown): boolean {
  let candidate: unknown = error
  for (let depth = 0; candidate && depth < 5; depth += 1) {
    if (typeof candidate !== 'object') {
      return false
    }
    const record = candidate as { code?: unknown; cause?: unknown }
    if (typeof record.code === 'string' && TRANSIENT_ERROR_CODES.has(record.code)) {
      return true
    }
    candidate = record.cause
  }
  return false
}

function mapTransportError(error: unknown): Error {
  const detail = formatMulticaDiagnostic(
    error instanceof Error ? error.message : String(error),
    TRANSPORT_ERROR_DETAIL_MAX_CHARS
  )
  return createMulticaError(
    'MulticaTransportError',
    detail ? `Multica API request failed: ${detail}` : 'Multica API request failed'
  )
}

function abortedError(): Error {
  return createMulticaError('MulticaAbortError', 'Multica API request was aborted')
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}
