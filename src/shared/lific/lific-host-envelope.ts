import type { ProcessInvocation } from './lific-types'

export type HostExecutionEnvelope = {
  schemaVersion: 1
  invocation: ProcessInvocation
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0
    const b = bytes[index + 1] ?? 0
    const c = bytes[index + 2] ?? 0
    const triple = (a << 16) | (b << 8) | c
    output += BASE64[(triple >> 18) & 63]
    output += BASE64[(triple >> 12) & 63]
    output += index + 1 < bytes.length ? BASE64[(triple >> 6) & 63] : '='
    output += index + 2 < bytes.length ? BASE64[triple & 63] : '='
  }
  return output
}

function decodeBase64Utf8(encoded: string): string {
  const clean = encoded.trim().replace(/\s+/g, '')
  if (!clean || clean.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(clean)) {
    throw new Error('Invalid Orca Lific execution envelope')
  }
  const bytes: number[] = []
  for (let index = 0; index < clean.length; index += 4) {
    const chars = clean.slice(index, index + 4)
    const values = [...chars].map((char) => (char === '=' ? 0 : BASE64.indexOf(char)))
    if (values.some((value) => value < 0)) {
      throw new Error('Invalid Orca Lific execution envelope')
    }
    const triple = (values[0]! << 18) | (values[1]! << 12) | (values[2]! << 6) | values[3]!
    bytes.push((triple >> 16) & 255)
    if (chars[2] !== '=') {
      bytes.push((triple >> 8) & 255)
    }
    if (chars[3] !== '=') {
      bytes.push(triple & 255)
    }
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes))
}

export function encodeHostExecutionEnvelope(invocation: ProcessInvocation): string {
  const envelope: HostExecutionEnvelope = { schemaVersion: 1, invocation }
  return encodeBase64Utf8(JSON.stringify(envelope))
}

export function decodeHostExecutionEnvelope(encoded: string): ProcessInvocation {
  let value: unknown
  try {
    value = JSON.parse(decodeBase64Utf8(encoded))
  } catch {
    throw new Error('Invalid Orca Lific execution envelope')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Orca Lific execution envelope')
  }
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== 1 || !raw.invocation || typeof raw.invocation !== 'object') {
    throw new Error('Unsupported Orca Lific execution envelope')
  }
  const invocation = raw.invocation as Record<string, unknown>
  if (
    typeof invocation.command !== 'string' ||
    !Array.isArray(invocation.args) ||
    !invocation.args.every((entry) => typeof entry === 'string') ||
    invocation.shell !== false
  ) {
    throw new Error('Invalid process invocation in Orca Lific execution envelope')
  }
  const env = invocation.env
  if (
    env !== undefined &&
    (!env ||
      typeof env !== 'object' ||
      Array.isArray(env) ||
      !Object.values(env).every((entry) => typeof entry === 'string'))
  ) {
    throw new Error('Invalid process environment in Orca Lific execution envelope')
  }
  const cwd = invocation.cwd
  if (cwd !== undefined && typeof cwd !== 'string') {
    throw new Error('Invalid process cwd in Orca Lific execution envelope')
  }
  const stdin = invocation.stdin
  if (stdin !== undefined && typeof stdin !== 'string') {
    throw new Error('Invalid process stdin in Orca Lific execution envelope')
  }
  return {
    command: invocation.command,
    args: invocation.args as string[],
    shell: false,
    ...(env ? { env: env as Record<string, string> } : {}),
    ...(cwd ? { cwd } : {}),
    ...(stdin !== undefined ? { stdin } : {})
  }
}
