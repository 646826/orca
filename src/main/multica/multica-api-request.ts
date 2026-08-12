import type { MulticaConnectionProfile } from '../../shared/multica/multica-types'

export const MULTICA_API_BODY_MAX_BYTES = 1024 * 1024

export type MulticaApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type MulticaApiQueryScalar = string | number | boolean
export type MulticaApiQueryValue =
  | MulticaApiQueryScalar
  | readonly MulticaApiQueryScalar[]
  | null
  | undefined

export type MulticaApiRequestInput = {
  method: MulticaApiMethod
  endpoint: string
  scope:
    | { kind: 'global' }
    | { kind: 'workspace'; workspaceId?: string }
  query?: Readonly<Record<string, MulticaApiQueryValue>>
  body?: unknown
  requestId?: string
  idempotencyKey?: string
}

export type MulticaApiRequest = {
  url: string
  init: {
    method: MulticaApiMethod
    headers: Record<string, string>
    body?: string
  }
}

const SAFE_HEADER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SUPPORTED_METHODS = new Set<MulticaApiMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const API_ENDPOINT_MAX_LENGTH = 4096
const QUERY_KEY_MAX_LENGTH = 128
const QUERY_VALUE_MAX_LENGTH = 16 * 1024

export function buildMulticaApiRequest(
  profile: MulticaConnectionProfile,
  token: string,
  input: MulticaApiRequestInput
): MulticaApiRequest {
  const method = requireMethod(input.method)
  const serverOrigin = resolveServerOrigin(profile)
  const endpoint = requireApiEndpoint(input.endpoint)
  const credential = requireHeaderValue(token, 'credential token', 8192)
  const workspaceId = resolveWorkspaceId(profile, input.scope)
  const body = serializeBody(method, input.body)
  const query = serializeQuery(input.query)
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${credential}`
  }

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }
  if (input.idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = requireHeaderToken(
      input.idempotencyKey,
      'idempotency key',
      256
    )
  }
  if (workspaceId !== undefined) {
    headers['X-Workspace-ID'] = workspaceId
  }
  if (input.requestId !== undefined) {
    headers['X-Request-ID'] = requireHeaderToken(input.requestId, 'request ID', 128)
  }

  return {
    url: `${serverOrigin}${endpoint}${query ? `?${query}` : ''}`,
    init: {
      method,
      headers,
      ...(body === undefined ? {} : { body })
    }
  }
}

function requireMethod(method: MulticaApiMethod): MulticaApiMethod {
  if (!SUPPORTED_METHODS.has(method)) {
    throw new Error('Invalid Multica API method')
  }
  return method
}

function resolveServerOrigin(profile: MulticaConnectionProfile): string {
  if (profile.dataPlane.kind !== 'rest') {
    throw new Error('Multica profile does not configure a REST transport')
  }

  const raw = requireSafeText(profile.dataPlane.serverUrl, 'API server URL', 2048)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Invalid Multica API server URL')
  }

  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid Multica API server URL')
  }
  return url.origin
}

function requireApiEndpoint(endpoint: string): string {
  const raw = requireSafeText(endpoint, 'API endpoint', API_ENDPOINT_MAX_LENGTH)
  if (
    !raw.startsWith('/') ||
    raw.startsWith('//') ||
    raw.includes('?') ||
    raw.includes('#') ||
    raw.includes('\\')
  ) {
    throw new Error('Invalid Multica API endpoint')
  }

  let decoded = raw
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      const next = decodeURIComponent(decoded)
      if (next === decoded) {
        break
      }
      decoded = next
    }
  } catch {
    throw new Error('Invalid Multica API endpoint')
  }

  if (
    (decoded !== '/api' && !decoded.startsWith('/api/')) ||
    decoded.includes('?') ||
    decoded.includes('#') ||
    decoded.includes('\\') ||
    decoded.includes('//') ||
    containsControlCharacter(decoded) ||
    /\s/.test(decoded) ||
    decoded.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid Multica API endpoint')
  }
  return raw
}

function resolveWorkspaceId(
  profile: MulticaConnectionProfile,
  scope: MulticaApiRequestInput['scope']
): string | undefined {
  if (scope.kind === 'global') {
    return undefined
  }
  if (scope.kind !== 'workspace') {
    throw new Error('Invalid Multica API request scope')
  }

  const workspaceId = scope.workspaceId ?? profile.defaultWorkspaceId
  if (!workspaceId) {
    throw new Error('Multica API request requires a workspace')
  }
  return requireHeaderToken(workspaceId, 'workspace ID', 256)
}

function serializeBody(method: MulticaApiMethod, body: unknown): string | undefined {
  if (body === undefined) {
    return undefined
  }
  if (method === 'GET' || method === 'DELETE') {
    throw new Error(`Multica ${method} requests cannot include a body`)
  }

  let serialized: string | undefined
  try {
    serialized = JSON.stringify(body)
  } catch {
    throw new Error('Multica API body is not JSON serializable')
  }
  if (serialized === undefined) {
    throw new Error('Multica API body is not JSON serializable')
  }
  if (new TextEncoder().encode(serialized).byteLength > MULTICA_API_BODY_MAX_BYTES) {
    throw new Error(`Multica API body exceeds ${MULTICA_API_BODY_MAX_BYTES} bytes`)
  }
  return serialized
}

function serializeQuery(
  query: Readonly<Record<string, MulticaApiQueryValue>> | undefined
): string {
  if (query === undefined) {
    return ''
  }
  if (query === null || typeof query !== 'object' || Array.isArray(query)) {
    throw new Error('Invalid Multica API query')
  }

  const search = new URLSearchParams()
  for (const key of Object.keys(query).sort()) {
    requireQueryKey(key)
    const value = query[key]
    if (value === null || value === undefined) {
      continue
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        search.append(key, formatQueryScalar(item))
      }
      continue
    }
    search.append(key, formatQueryScalar(value as MulticaApiQueryScalar))
  }
  return search.toString()
}

function requireQueryKey(key: string): void {
  if (
    !key ||
    key.length > QUERY_KEY_MAX_LENGTH ||
    !/^[A-Za-z0-9_.-]+$/.test(key)
  ) {
    throw new Error('Invalid Multica API query key')
  }
}

function formatQueryScalar(value: MulticaApiQueryScalar): string {
  switch (typeof value) {
    case 'string':
      if (value.length > QUERY_VALUE_MAX_LENGTH || containsControlCharacter(value)) {
        throw new Error('Invalid Multica API query value')
      }
      return value
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('Invalid Multica API query value')
      }
      return String(value)
    case 'boolean':
      return String(value)
    default:
      throw new Error('Invalid Multica API query value')
  }
}

function requireHeaderToken(value: string, label: string, maxLength: number): string {
  const safe = requireSafeText(value, label, maxLength)
  if (!SAFE_HEADER_TOKEN.test(safe)) {
    throw new Error(`Invalid Multica ${label}`)
  }
  return safe
}

function requireHeaderValue(value: string, label: string, maxLength: number): string {
  const safe = requireSafeText(value, label, maxLength)
  if (safe !== safe.trim()) {
    throw new Error(`Invalid Multica ${label}`)
  }
  return safe
}

function requireSafeText(value: string, label: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maxLength ||
    containsControlCharacter(value)
  ) {
    throw new Error(`Invalid Multica ${label}`)
  }
  return value
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127) {
      return true
    }
  }
  return false
}
