import type { MulticaConnectionProfile } from '../../shared/multica/multica-types'
import { redactMulticaSecrets } from '../../shared/multica/multica-redaction'
import {
  buildMulticaApiRequest,
  type MulticaApiMethod,
  type MulticaApiRequestInput
} from './multica-api-request'

export const MULTICA_REST_RESPONSE_MAX_BYTES = 10 * 1024 * 1024

const HTTP_ERROR_DETAIL_MAX_CHARS = 2048
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

export class MulticaHttpError extends Error {
  readonly status: number
  readonly statusText: string
  readonly requestId: string | undefined
  readonly bodySnippet: string

  constructor(
    status: number,
    statusText: string,
    bodySnippet: string,
    requestId: string | undefined
  ) {
    const summary = statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`
    super(
      bodySnippet
        ? `Multica API request failed with ${summary}: ${bodySnippet}`
        : `Multica API request failed with ${summary}`
    )
    this.name = 'MulticaHttpError'
    this.status = status
    this.statusText = statusText
    this.requestId = requestId
    this.bodySnippet = bodySnippet
  }
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

    if (response.status === 204) {
      return undefined
    }

    const text = await readBoundedResponseText(response)
    if (!response.ok) {
      const requestId = boundedHeader(response.headers.get('x-request-id'))
      throw new MulticaHttpError(
        response.status,
        response.statusText,
        formatDiagnostic(text, HTTP_ERROR_DETAIL_MAX_CHARS),
        requestId
      )
    }
    if (!text.trim()) {
      return undefined
    }

    try {
      return JSON.parse(text) as T
    } catch {
      throw namedError('MulticaInvalidResponseError', 'Multica API returned invalid JSON')
    }
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
          throw namedError(
            'MulticaTimeoutError',
            `Multica API request timed out after ${this.timeoutMs}ms`
          )
        }
        if (error instanceof MulticaHttpError) {
          throw error
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
        throw namedError('MulticaRedirectError', 'Multica API redirect limit exceeded')
      }

      const nextUrl = new URL(location, currentUrl)
      if (nextUrl.origin !== pinnedOrigin) {
        throw namedError('MulticaRedirectError', 'Multica API redirect changed origin')
      }
      if ((init.method ?? 'GET') !== 'GET' && response.status !== 307 && response.status !== 308) {
        throw namedError(
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
    controller.abort(namedError('TimeoutError', `Timed out after ${timeoutMs}ms`))
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

async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = parseContentLength(response.headers.get('content-length'))
  if (contentLength !== undefined && contentLength > MULTICA_REST_RESPONSE_MAX_BYTES) {
    throw responseTooLargeError()
  }
  if (!response.body) {
    return ''
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytesRead = 0
  let text = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      bytesRead += value.byteLength
      if (bytesRead > MULTICA_REST_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw responseTooLargeError()
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) {
    return undefined
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function assertResponseOrigin(response: Response, pinnedOrigin: string): void {
  if (!response.url) {
    return
  }
  let responseOrigin: string
  try {
    responseOrigin = new URL(response.url).origin
  } catch {
    throw namedError('MulticaRedirectError', 'Multica API response URL is invalid')
  }
  if (responseOrigin !== pinnedOrigin) {
    throw namedError('MulticaRedirectError', 'Multica API redirect changed origin')
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
  for (const candidate of errorChain(error)) {
    if (TRANSIENT_ERROR_CODES.has(candidate.code)) {
      return true
    }
  }
  return false
}

function errorChain(error: unknown): Array<{ code: string }> {
  const chain: Array<{ code: string }> = []
  let candidate: unknown = error

  while (candidate && chain.length < 5) {
    if (typeof candidate === 'object') {
      const record = candidate as { code?: unknown; cause?: unknown }
      if (typeof record.code === 'string') {
        chain.push({ code: record.code })
      }
      candidate = record.cause
    } else {
      break
    }
  }
  return chain
}

function mapTransportError(error: unknown): Error {
  const detail = formatDiagnostic(
    error instanceof Error ? error.message : String(error),
    TRANSPORT_ERROR_DETAIL_MAX_CHARS
  )
  return namedError(
    'MulticaTransportError',
    detail ? `Multica API request failed: ${detail}` : 'Multica API request failed'
  )
}

function responseTooLargeError(): Error {
  return namedError(
    'MulticaResponseTooLargeError',
    `Multica API response exceeds ${MULTICA_REST_RESPONSE_MAX_BYTES} bytes`
  )
}

function abortedError(): Error {
  return namedError('MulticaAbortError', 'Multica API request was aborted')
}

function namedError(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

function boundedHeader(value: string | null): string | undefined {
  if (!value) {
    return undefined
  }
  return redactMulticaSecrets(value).replace(/\s+/g, ' ').trim().slice(0, 256) || undefined
}

function formatDiagnostic(value: string, maxChars: number): string {
  return redactMulticaSecrets(value).replace(/\s+/g, ' ').trim().slice(0, maxChars)
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}
