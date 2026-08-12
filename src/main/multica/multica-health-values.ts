import { redactMulticaSecrets } from '../../shared/multica/multica-redaction'
import type { MulticaCapability } from '../../shared/multica/multica-types'

const CAPABILITY_ORDER: readonly MulticaCapability[] = [
  'workspaces',
  'projects',
  'issues',
  'comments',
  'runs',
  'agents',
  'squads',
  'skills',
  'runtimes',
  'assignments',
  'issue-metadata',
  'realtime',
  'managed-lifecycle'
]
const SERVER_CAPABILITIES = new Set<MulticaCapability>(
  CAPABILITY_ORDER.filter((capability) => capability !== 'managed-lifecycle')
)
const DIAGNOSTIC_MAX_CHARS = 1024
const VERSION_MAX_CHARS = 128

export function collectMulticaCapabilities(
  configPayload: unknown,
  managed: boolean
): MulticaCapability[] {
  const advertised = new Set<string>()
  if (isMulticaRecord(configPayload)) {
    collectCapabilitySource(configPayload.capabilities, advertised)
    collectCapabilitySource(configPayload.features, advertised)
  }

  const capabilities = CAPABILITY_ORDER.filter(
    (capability) =>
      capability !== 'managed-lifecycle' &&
      SERVER_CAPABILITIES.has(capability) &&
      advertised.has(capability)
  )
  if (managed) {
    capabilities.push('managed-lifecycle')
  }
  return capabilities
}

export function orderMulticaCapabilities(
  values: readonly MulticaCapability[]
): MulticaCapability[] {
  const present = new Set(values)
  return CAPABILITY_ORDER.filter((capability) => present.has(capability))
}

export function extractMulticaVersion(
  value: unknown,
  keys: readonly string[]
): string | undefined {
  if (typeof value === 'string') {
    return safeVersion(value)
  }
  if (!isMulticaRecord(value)) {
    return undefined
  }
  for (const key of keys) {
    const version = safeVersion(value[key])
    if (version) {
      return version
    }
  }
  return undefined
}

export function extractMulticaIdentifier(value: unknown): string | undefined {
  if (!isMulticaRecord(value)) {
    return undefined
  }
  return safeIdentifier(value.id) ?? safeIdentifier(value.workspaceId)
}

export function extractMulticaWorkspaceIds(value: unknown): string[] {
  const source = Array.isArray(value)
    ? value
    : isMulticaRecord(value) && Array.isArray(value.workspaces)
      ? value.workspaces
      : []
  return source
    .map((entry) => extractMulticaIdentifier(entry))
    .filter((entry): entry is string => entry !== undefined)
}

export function isMulticaExplicitlyUnauthenticated(value: unknown): boolean {
  return (
    isMulticaRecord(value) &&
    (value.authenticated === false ||
      value.authorized === false ||
      value.status === 'unauthenticated')
  )
}

export function multicaHealthDiagnostic(value: unknown, fallback: string): string {
  const detail = value instanceof Error ? value.message : typeof value === 'string' ? value : ''
  const safe = redactHealthDiagnostic(detail)
  return safe ? `${fallback}: ${safe}` : fallback
}

export function redactMulticaHealthMessage(value: string, fallback: string): string {
  return redactHealthDiagnostic(value) || fallback
}

export function isMulticaRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function collectCapabilitySource(value: unknown, target: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') {
        target.add(entry)
      }
    }
    return
  }
  if (!isMulticaRecord(value)) {
    return
  }
  for (const [name, enabled] of Object.entries(value)) {
    if (enabled === true) {
      target.add(name)
    }
  }
}

function redactHealthDiagnostic(value: string): string {
  return redactMulticaSecrets(value)
    .replace(/\bMULTICA_TOKEN=\[REDACTED\]/gi, '[REDACTED_MULTICA_CREDENTIAL]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DIAGNOSTIC_MAX_CHARS)
}

function safeVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > VERSION_MAX_CHARS || containsControlCharacter(trimmed)) {
    return undefined
  }
  return trimmed
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed || undefined
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
