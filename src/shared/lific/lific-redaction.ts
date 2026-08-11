import type { ProcessFailure } from './lific-types'

const SECRET_KEY =
  /(api[_-]?key|authorization|bearer|cookie|credential|password|private[_-]?key|secret|session|token)/i

export function redactLificSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, 'Bearer [REDACTED]')
    .replace(/\blific_(?:sk|at|sess)_[A-Za-z0-9._~-]+/gi, '[REDACTED]')
    .replace(
      /\b(LIFIC_API_KEY|LIFIC_CONNECT_KEY)\s*=\s*[^\s"']+/gi,
      (_match, name: string) => `${name}=[REDACTED]`
    )
    .replace(/("(?:key|token|authorization|secret|password)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(
      /((?:key|token|authorization|secret|password)\s*=\s*["'])[^"']*(["'])/gi,
      '$1[REDACTED]$2'
    )
}

function sanitizeArgv(args: readonly string[]): string[] {
  const result: string[] = []
  let redactNext = false
  for (const arg of args) {
    if (redactNext) {
      result.push('[REDACTED]')
      redactNext = false
      continue
    }
    if (/^--(?:api-key|key|token|password|authorization)$/i.test(arg)) {
      result.push(arg)
      redactNext = true
      continue
    }
    if (/^--(?:api-key|key|token|password|authorization)=/i.test(arg)) {
      result.push(`${arg.slice(0, arg.indexOf('='))}=[REDACTED]`)
      continue
    }
    result.push(redactLificSecrets(arg))
  }
  return result
}

export function sanitizeProcessFailure(failure: ProcessFailure): ProcessFailure {
  return {
    command: redactLificSecrets(failure.command),
    args: sanitizeArgv(failure.args),
    stdout: redactLificSecrets(failure.stdout),
    stderr: redactLificSecrets(failure.stderr),
    exitCode: failure.exitCode
  }
}

export function sanitizeUnknown(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    return SECRET_KEY.test(key) ? '[REDACTED]' : redactLificSecrets(value)
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeUnknown(entry))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        SECRET_KEY.test(entryKey) ? '[REDACTED]' : sanitizeUnknown(entryValue, entryKey)
      ])
    )
  }
  return value
}
