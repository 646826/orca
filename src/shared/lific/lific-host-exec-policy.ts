function executableBasename(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  const separator = normalized.lastIndexOf('/')
  return separator === -1 ? normalized : normalized.slice(separator + 1)
}

function normalizeBareExecutable(value: string): string {
  return value.replace(/\.exe$/i, '').toLowerCase()
}

/**
 * The remote host helper is intentionally not a generic process executor.
 * It accepts only the configured Lific executable. A Windows `.exe` spelling
 * difference is tolerated for bare commands, but paths must match exactly so
 * an attacker cannot substitute `/tmp/lific` for a trusted `lific` command.
 */
export function isAllowedLificExecutable(command: string, configured: string): boolean {
  if (command === configured) {
    return true
  }
  const commandBase = executableBasename(command)
  const configuredBase = executableBasename(configured)
  if (commandBase !== command || configuredBase !== configured) {
    return false
  }
  return normalizeBareExecutable(commandBase) === normalizeBareExecutable(configuredBase)
}
