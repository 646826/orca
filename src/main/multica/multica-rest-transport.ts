import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import {
  createMulticaError,
  formatMulticaDiagnostic,
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
const PERMANENT_REST_ERROR_NAMES = new Set([
  'MulticaAbortError',
  'MulticaInvalidResponseError',
  'MulticaRedirectError',
  'MulticaResponseTooLargeError'
])

export type MulticaFetch = typeof globalThis.fetch

export async function fetchMulticaRedirectChain(
  fetchImpl: MulticaFetch,
  initialUrl: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<Response> {
  const pinnedOrigin = new URL(initialUrl).origin
  let currentUrl = initialUrl

  for (let redirectCount = 0; ; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, { ...init, signal, redirect: 'manual' })
    try {
      assertResponseOrigin(response, pinnedOrigin)
    } catch (error) {
      await cancelUnreadResponseBody(response)
      throw error
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response
    }

    const location = response.headers.get('location')
    if (!location) {
      return response
    }
    if (redirectCount >= MAX_REDIRECTS) {
      return await rejectRedirect(response, 'Multica API redirect limit exceeded')
    }

    let nextUrl: URL
    try {
      nextUrl = new URL(location, currentUrl)
    } catch {
      return await rejectRedirect(response, 'Multica API redirect URL is invalid')
    }
    if (nextUrl.origin !== pinnedOrigin) {
      return await rejectRedirect(response, 'Multica API redirect changed origin')
    }
    if ((init.method ?? 'GET') !== 'GET' && response.status !== 307 && response.status !== 308) {
      return await rejectRedirect(response, 'Multica API mutation redirect is not supported')
    }

    await cancelUnreadResponseBody(response)
    currentUrl = nextUrl.toString()
  }
}

export function createMulticaAttemptSignal(
  timeoutMs: number,
  externalSignal: AbortSignal | undefined
): {
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

export function requireMulticaClientVersion(value: string): string {
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

export function requireMulticaTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new Error('Multica REST timeout is invalid')
  }
  return value
}

export function requireMulticaRetryDelays(values: readonly number[]): readonly number[] {
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

export function isTransientMulticaTransportError(error: unknown): boolean {
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

export function isPermanentMulticaRestError(error: unknown): boolean {
  return (
    error instanceof MulticaHttpError ||
    (error instanceof Error && PERMANENT_REST_ERROR_NAMES.has(error.name))
  )
}

export function mapMulticaTransportError(error: unknown): Error {
  const detail = formatMulticaDiagnostic(
    error instanceof Error ? error.message : String(error),
    TRANSPORT_ERROR_DETAIL_MAX_CHARS
  )
  return createMulticaError(
    'MulticaTransportError',
    detail ? `Multica API request failed: ${detail}` : 'Multica API request failed'
  )
}

export function multicaAbortedError(): Error {
  return createMulticaError('MulticaAbortError', 'Multica API request was aborted')
}

export async function defaultMulticaSleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}

async function rejectRedirect(response: Response, message: string): Promise<never> {
  await cancelUnreadResponseBody(response)
  throw createMulticaError('MulticaRedirectError', message)
}

function assertResponseOrigin(response: Response, pinnedOrigin: string): void {
  if (!response.url) {
    return
  }
  let responseOrigin: string
  try {
    responseOrigin = new URL(response.url).origin
  } catch {
    throw createMulticaError('MulticaRedirectError', 'Multica API response URL is invalid')
  }
  if (responseOrigin !== pinnedOrigin) {
    throw createMulticaError('MulticaRedirectError', 'Multica API redirect changed origin')
  }
}
