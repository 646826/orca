import type {
  LificClientId,
  LificScope,
  LificTransport,
  ProcessInvocation
} from '../../shared/lific/lific-types'

function envRecord(name: string, value: string): Record<string, string> {
  return { [name]: value }
}

export function buildLificConnectInvocation(input: {
  executable: string
  clientId: LificClientId
  scope: LificScope
  transport: LificTransport
  provisionedKey?: string
  oauth?: boolean
  configOnly?: boolean
  dryRun: boolean
  cwd?: string
}): ProcessInvocation {
  const args = ['--json', 'connect', '--client', input.clientId, '--scope', input.scope]
  let env: Record<string, string> | undefined

  if (input.transport.kind === 'stdio') {
    if (input.configOnly) {
      throw new Error('config-only mode cannot be combined with stdio')
    }
    args.push('--stdio', '--db', input.transport.databasePath)
  } else {
    args.push('--url', input.transport.mcpUrl)
    if (input.configOnly) {
      args.push('--config-only')
    }
    if (input.oauth) {
      args.push('--oauth')
    } else {
      if (!input.provisionedKey) {
        throw new Error('HTTP key mode requires a provisioned per-harness key')
      }
      args.push('--key-env', 'LIFIC_CONNECT_KEY')
      env = envRecord('LIFIC_CONNECT_KEY', input.provisionedKey)
    }
  }

  args.push('--yes', '--skip-agents')
  if (input.dryRun) {
    args.push('--dry-run')
  }

  return {
    command: input.executable,
    args,
    shell: false,
    ...(env ? { env } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {})
  }
}

export function buildLificDataInvocation(input: {
  executable: string
  transport: LificTransport
  credential?: string
  args: string[]
  cwd?: string
}): ProcessInvocation {
  const args = ['--json']
  let env: Record<string, string> | undefined
  if (input.transport.kind === 'http') {
    args.push('--backend', 'http', '--url', input.transport.baseUrl)
    if (input.credential) {
      env = envRecord('LIFIC_API_KEY', input.credential)
    }
  } else {
    args.push('--db', input.transport.databasePath)
  }
  args.push(...input.args)
  return {
    command: input.executable,
    args,
    shell: false,
    ...(env ? { env } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {})
  }
}

/**
 * Build a health probe for the selected connection rather than for whichever
 * local instance `lific doctor` discovers on the execution host.
 *
 * HTTP profiles use the CLI's HTTP backend against the explicit base URL. The
 * credential is delivered only through LIFIC_API_KEY. Stdio profiles keep the
 * richer local doctor check because their database lives on the execution host.
 */
export function buildLificHealthInvocation(input: {
  executable: string
  transport: LificTransport
  credential?: string
  cwd?: string
}): ProcessInvocation {
  if (input.transport.kind === 'http') {
    return buildLificDataInvocation({
      executable: input.executable,
      transport: input.transport,
      ...(input.credential ? { credential: input.credential } : {}),
      args: ['project', 'list'],
      ...(input.cwd ? { cwd: input.cwd } : {})
    })
  }

  return {
    command: input.executable,
    args: ['--json', 'doctor', '--db', input.transport.databasePath],
    shell: false,
    ...(input.cwd ? { cwd: input.cwd } : {})
  }
}

export function buildLificAgentsMdInvocation(input: {
  executable: string
  path: string
  project?: string
  cwd?: string
}): ProcessInvocation {
  return {
    command: input.executable,
    args: [
      '--json',
      'agents-md',
      '--path',
      input.path,
      ...(input.project ? ['--project', input.project] : [])
    ],
    shell: false,
    ...(input.cwd ? { cwd: input.cwd } : {})
  }
}
