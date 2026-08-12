import type { MulticaConnectionProfile } from '../../shared/multica/multica-types'
import {
  buildMulticaApiRequest,
  type MulticaApiMethod,
  type MulticaApiRequestInput
} from './multica-api-request'
import {
  createMulticaError,
  parseMulticaJsonResponse
} from './multica-rest-response'
import {
  createMulticaAttemptSignal,
  defaultMulticaSleep,
  fetchMulticaRedirectChain,
  isPermanentMulticaRestError,
  isTransientMulticaTransportError,
  mapMulticaTransportError,
  multicaAbortedError,
  requireMulticaClientVersion,
  requireMulticaRetryDelays,
  requireMulticaTimeout,
  type MulticaFetch
} from './multica-rest-transport'

export {
  MULTICA_REST_RESPONSE_MAX_BYTES,
  MulticaHttpError
} from './multica-rest-response'
export type { MulticaFetch } from './multica-rest-transport'

export type MulticaRestClientOptions = {
  profile: MulticaConnectionProfile
  token: string
  fetch: MulticaFetch
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
    this.fetchImpl = options.fetch
    this.clientVersion = requireMulticaClientVersion(options.clientVersion ?? 'unknown')
    this.timeoutMs = requireMulticaTimeout(options.timeoutMs ?? 30_000)
    this.retryDelaysMs = requireMulticaRetryDelays(options.retryDelaysMs ?? [100, 300])
    this.sleep = options.sleep ?? defaultMulticaSleep
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
    return await this.requestWithPolicy<T>(
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
  }

  private async requestWithPolicy<T>(
    url: string,
    init: RequestInit,
    externalSignal: AbortSignal | undefined
  ): Promise<T | undefined> {
    const method = init.method ?? 'GET'

    for (let attempt = 0; ; attempt += 1) {
      if (externalSignal?.aborted) {
        throw multicaAbortedError()
      }

      const attemptSignal = createMulticaAttemptSignal(this.timeoutMs, externalSignal)
      try {
        const response = await fetchMulticaRedirectChain(
          this.fetchImpl,
          url,
          init,
          attemptSignal.signal
        )
        return await parseMulticaJsonResponse<T>(response)
      } catch (error) {
        if (externalSignal?.aborted) {
          throw multicaAbortedError()
        }

        const retryDelay = method === 'GET' ? this.retryDelaysMs[attempt] : undefined
        const transient =
          attemptSignal.didTimeout() || isTransientMulticaTransportError(error)
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
        if (isPermanentMulticaRestError(error)) {
          throw error
        }
        throw mapMulticaTransportError(error)
      } finally {
        attemptSignal.cleanup()
      }
    }
  }
}
