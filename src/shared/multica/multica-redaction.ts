const MULTICA_TOKEN = /\b(?:mul|mat|mcn|mdt)_[A-Za-z0-9._~-]{8,}\b/gi

export function redactMulticaSecrets(value: string): string {
  return value
    .replace(/\b(Authorization\s*:\s*Bearer)\s+[^\s"']+/gi, '$1 [REDACTED]')
    .replace(MULTICA_TOKEN, '[REDACTED_MULTICA_TOKEN]')
    .replace(
      /\b(MULTICA_TOKEN)\s*=\s*[^\s"']+/gi,
      (_match, name: string) => `${name}=[REDACTED]`
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(/("(?:key|token|authorization|secret|password)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(
      /((?:key|token|authorization|secret|password)\s*=\s*["'])[^"']*(["'])/gi,
      '$1[REDACTED]$2'
    )
}
