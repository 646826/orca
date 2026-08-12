export const MULTICA_HOST_ENVELOPE_MAX_BYTES = 1024 * 1024
export const MULTICA_PROCESS_MAX_ARGS = 128

export const MULTICA_PROCESS_ENV_KEYS = [
  'MULTICA_TOKEN',
  'MULTICA_SERVER_URL',
  'MULTICA_WORKSPACE_ID',
  'MULTICA_PROFILE'
] as const

export type MulticaProcessEnvironmentKey = (typeof MULTICA_PROCESS_ENV_KEYS)[number]

export type MulticaProcessInvocation = {
  command: string
  args: string[]
  shell: false
  env?: Record<string, string>
  cwd?: string
  stdin?: string
}

export type MulticaProcessResult = {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
}

type MulticaHostEnvelope = {
  schemaVersion: 1
  invocation: MulticaProcessInvocation
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const NUL = String.fromCharCode(0)
const INVOCATION_FIELDS = new Set(['command', 'args', 'shell', 'env', 'cwd', 'stdin'])
const ENV_KEYS = new Set<string>(MULTICA_PROCESS_ENV_KEYS)
const MAX_BASE64_BYTES = Math.ceil(MULTICA_HOST_ENVELOPE_MAX_BYTES / 3) * 4

export function encodeMulticaHostEnvelope(invocation: MulticaProcessInvocation): string {
  const validated = validateInvocation(invocation)
  const text = JSON.stringify({ schemaVersion: 1, invocation: validated } satisfies MulticaHostEnvelope)
  assertEnvelopeSize(text)
  return encodeBase64Utf8(text)
}

export function decodeMulticaHostEnvelope(encoded: string): MulticaProcessInvocation {
  const clean = encoded.trim()
  if (clean.length > MAX_BASE64_BYTES + 4) {
    throw envelopeSizeError()
  }

  let text: string
  try {
    text = decodeBase64Utf8(clean)
    if (encodeBase64Utf8(text) !== clean) {
      throw new Error('non-canonical base64')
    }
  } catch {
    throw new Error('Invalid Orca Multica execution envelope')
  }
  assertEnvelopeSize(text)

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('Invalid Orca Multica execution envelope')
  }
  if (!isRecord(value)) {
    throw new Error('Invalid Orca Multica execution envelope')
  }
  if (value.schemaVersion !== 1) {
    throw new Error('Unsupported Orca Multica execution envelope')
  }
  if (!isRecord(value.invocation)) {
    throw new Error('Unsupported Orca Multica execution envelope')
  }
  for (const key of Object.keys(value)) {
    if (key !== 'schemaVersion' && key !== 'invocation') {
      throw new Error(`Unknown Orca Multica execution envelope field '${key}'`)
    }
  }
  return validateInvocation(value.invocation)
}

function validateInvocation(value: unknown): MulticaProcessInvocation {
  if (!isRecord(value)) {
    throw new Error('Invalid Multica process invocation')
  }
  for (const key of Object.keys(value)) {
    if (!INVOCATION_FIELDS.has(key)) {
      throw new Error(`Unknown Multica process invocation field '${key}'`)
    }
  }
  if (value.shell !== false) {
    throw new Error('Multica process invocation requires shell=false')
  }
  if (typeof value.command !== 'string' || !value.command.trim()) {
    throw new Error('Multica process invocation requires a command')
  }
  if (!Array.isArray(value.args) || !value.args.every((entry) => typeof entry === 'string')) {
    throw new Error('Multica process invocation requires string arguments')
  }
  if (value.args.length > MULTICA_PROCESS_MAX_ARGS) {
    throw new Error(`Multica process invocation supports at most ${MULTICA_PROCESS_MAX_ARGS} arguments`)
  }
  if (value.cwd !== undefined && (typeof value.cwd !== 'string' || !value.cwd.trim())) {
    throw new Error('Invalid Multica process working directory')
  }
  if (value.stdin !== undefined && typeof value.stdin !== 'string') {
    throw new Error('Invalid Multica process stdin')
  }

  const env = validateEnvironment(value.env)
  const strings = [
    value.command,
    ...value.args,
    ...(value.cwd === undefined ? [] : [value.cwd]),
    ...(value.stdin === undefined ? [] : [value.stdin]),
    ...Object.values(env)
  ]
  if (strings.some((entry) => entry.includes(NUL))) {
    throw new Error('Multica process invocation contains a NUL byte')
  }

  return {
    command: value.command,
    args: [...value.args],
    shell: false,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    ...(value.stdin === undefined ? {} : { stdin: value.stdin })
  }
}

function validateEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) {
    return {}
  }
  if (!isRecord(value)) {
    throw new Error('Invalid Multica process environment')
  }
  const env: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!ENV_KEYS.has(key)) {
      throw new Error(`Multica process environment key '${key}' is not allowed`)
    }
    if (typeof entry !== 'string') {
      throw new Error(`Multica process environment value '${key}' must be a string`)
    }
    env[key] = entry
  }
  return env
}

function assertEnvelopeSize(text: string): void {
  const byteLength = new TextEncoder().encode(text).byteLength
  if (byteLength > MULTICA_HOST_ENVELOPE_MAX_BYTES) {
    throw envelopeSizeError()
  }
}

function envelopeSizeError(): Error {
  return new Error(
    `Multica host execution envelope exceeds ${MULTICA_HOST_ENVELOPE_MAX_BYTES} bytes`
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1] ?? 0
    const third = bytes[index + 2] ?? 0
    const triple = (first << 16) | (second << 8) | third
    output += BASE64[(triple >> 18) & 63]
    output += BASE64[(triple >> 12) & 63]
    output += index + 1 < bytes.length ? BASE64[(triple >> 6) & 63] : '='
    output += index + 2 < bytes.length ? BASE64[triple & 63] : '='
  }
  return output
}

function decodeBase64Utf8(encoded: string): string {
  if (!encoded || encoded.length % 4 !== 0 || !BASE64_PATTERN.test(encoded)) {
    throw new Error('invalid base64')
  }
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  const bytes = new Uint8Array((encoded.length / 4) * 3 - padding)
  let offset = 0
  for (let index = 0; index < encoded.length; index += 4) {
    const chars = encoded.slice(index, index + 4)
    const first = BASE64.indexOf(chars[0]!)
    const second = BASE64.indexOf(chars[1]!)
    const third = chars[2] === '=' ? 0 : BASE64.indexOf(chars[2]!)
    const fourth = chars[3] === '=' ? 0 : BASE64.indexOf(chars[3]!)
    const triple = (first << 18) | (second << 12) | (third << 6) | fourth
    bytes[offset++] = (triple >> 16) & 255
    if (chars[2] !== '=') {
      bytes[offset++] = (triple >> 8) & 255
    }
    if (chars[3] !== '=') {
      bytes[offset++] = triple & 255
    }
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
