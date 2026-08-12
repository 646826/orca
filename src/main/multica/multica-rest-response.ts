import { redactMulticaSecrets } from '../../shared/multica/multica-redaction'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'

export const MULTICA_REST_RESPONSE_MAX_BYTES = 10 * 1024 * 1024

const HTTP_ERROR_DETAIL_MAX_CHARS = 2048
const HTTP_STATUS_TEXT_MAX_CHARS = 256
const REQUEST_ID_MAX_CHARS = 256

export class MulticaHttpError extends Error {
  readonly status: number
  readonly statusText: string
  readonly requestId: string | undefined
  readonly bodySnippet: string

  constructor(
    status: number,
    statusText: string,
    body: string,
    requestId: string | null | undefined
  ) {
    const safeStatusText = formatMulticaDiagnostic(statusText, HTTP_STATUS_TEXT_MAX_CHARS)
    const safeBody = formatMulticaDiagnostic(body, HTTP_ERROR_DETAIL_MAX_CHARS)
    const summary = safeStatusText ? `HTTP ${status} ${safeStatusText}` : `HTTP ${status}`
    super(
      safeBody
        ? `Multica API request failed with ${summary}: ${safeBody}`
        : `Multica API request failed with ${summary}`
    )
    this.name = 'MulticaHttpError'
    this.status = status
    this.statusText = safeStatusText
    this.requestId = boundedHeader(requestId)
    this.bodySnippet = safeBody
  }
}

export async function parseMulticaJsonResponse<T>(
  response: Response
): Promise<T | undefined> {
  if (response.status === 204) {
    return undefined
  }

  const text = await readBoundedResponseText(response)
  if (!response.ok) {
    throw new MulticaHttpError(
      response.status,
      response.statusText,
      text,
      response.headers.get('x-request-id')
    )
  }
  if (!text.trim()) {
    return undefined
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw createMulticaError(
      'MulticaInvalidResponseError',
      'Multica API returned invalid JSON'
    )
  }
}

export function createMulticaError(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

export function formatMulticaDiagnostic(value: string, maxChars: number): string {
  return redactMulticaSecrets(value).replace(/\s+/g, ' ').trim().slice(0, maxChars)
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = parseContentLength(response.headers.get('content-length'))
  if (contentLength !== undefined && contentLength > MULTICA_REST_RESPONSE_MAX_BYTES) {
    await cancelUnreadResponseBody(response)
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

function responseTooLargeError(): Error {
  return createMulticaError(
    'MulticaResponseTooLargeError',
    `Multica API response exceeds ${MULTICA_REST_RESPONSE_MAX_BYTES} bytes`
  )
}

function boundedHeader(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  return formatMulticaDiagnostic(value, REQUEST_ID_MAX_CHARS) || undefined
}
