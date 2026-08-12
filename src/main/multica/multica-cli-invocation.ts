import type { MulticaProcessInvocation } from '../../shared/multica/multica-host-envelope'
import type { MulticaConnectionProfile } from '../../shared/multica/multica-types'

export type MulticaCliReadOperation =
  | { kind: 'version' }
  | { kind: 'auth-status' }
  | { kind: 'workspace-list' }
  | { kind: 'project-list' }
  | {
      kind: 'issue-list'
      status?: string
      priority?: string
      assignee?: string
      project?: string
      limit?: number
      offset?: number
      sort?: string
    }
  | { kind: 'issue-get'; issueId: string }
  | { kind: 'issue-search'; query: string; limit?: number; includeClosed?: boolean }
  | { kind: 'agent-list' }
  | { kind: 'skill-list' }
  | { kind: 'runtime-list' }

export type MulticaCliInvocationOptions = {
  token?: string
  workspaceId?: string
  cwd?: string
}

type ResolvedMulticaCli = {
  executable: string
  profileName?: string
  serverUrl?: string
}

const WORKSPACE_SCOPED_OPERATIONS = new Set<MulticaCliReadOperation['kind']>([
  'project-list',
  'issue-list',
  'issue-get',
  'issue-search',
  'agent-list',
  'skill-list',
  'runtime-list'
])
const SAFE_SORT = /^[A-Za-z0-9_.:-]{1,128}$/

export function buildMulticaCliInvocation(
  profile: MulticaConnectionProfile,
  operation: MulticaCliReadOperation,
  options: MulticaCliInvocationOptions = {}
): MulticaProcessInvocation {
  const cli = resolveCli(profile)
  const command = requireSafeText(cli.executable, 'CLI executable', 1024)
  const args: string[] = []

  if (cli.serverUrl) {
    args.push('--server-url', requireHttpUrl(cli.serverUrl))
  }

  if (WORKSPACE_SCOPED_OPERATIONS.has(operation.kind)) {
    const workspaceId = options.workspaceId ?? profile.defaultWorkspaceId
    if (!workspaceId) {
      throw new Error(`Multica operation ${operation.kind} requires a workspace`)
    }
    args.push('--workspace-id', requireSafeText(workspaceId, 'workspace ID', 256))
  }

  if (cli.profileName) {
    args.push('--profile', requireSafeText(cli.profileName, 'CLI profile name', 128))
  }
  args.push(...buildOperationArgs(operation))

  const token = options.token
  const env =
    token === undefined
      ? undefined
      : { MULTICA_TOKEN: requireSafeText(token, 'credential token', 8192) }
  const cwd =
    options.cwd === undefined
      ? undefined
      : requireSafeText(options.cwd, 'working directory', 4096)

  return {
    command,
    args,
    shell: false,
    ...(env ? { env } : {}),
    ...(cwd ? { cwd } : {})
  }
}

function resolveCli(profile: MulticaConnectionProfile): ResolvedMulticaCli {
  const dataPlane = profile.dataPlane
  if (dataPlane.kind === 'cli') {
    return {
      executable: dataPlane.executable,
      profileName: dataPlane.profileName,
      serverUrl: dataPlane.serverUrl
    }
  }
  if (!dataPlane.cliFallback) {
    throw new Error('Multica profile does not configure a CLI transport')
  }
  return {
    executable: dataPlane.cliFallback.executable,
    profileName: dataPlane.cliFallback.profileName,
    serverUrl: dataPlane.serverUrl
  }
}

function buildOperationArgs(operation: MulticaCliReadOperation): string[] {
  switch (operation.kind) {
    case 'version':
      return jsonArgs('version')
    case 'auth-status':
      return jsonArgs('auth', 'status')
    case 'workspace-list':
      return jsonArgs('workspace', 'list')
    case 'project-list':
      return jsonArgs('project', 'list')
    case 'agent-list':
      return jsonArgs('agent', 'list')
    case 'skill-list':
      return jsonArgs('skill', 'list')
    case 'runtime-list':
      return jsonArgs('runtime', 'list')
    case 'issue-get':
      return [
        'issue',
        'get',
        requireOpaqueIdentifier(operation.issueId, 'issue ID'),
        '--output',
        'json'
      ]
    case 'issue-search':
      return buildIssueSearchArgs(operation)
    case 'issue-list':
      return buildIssueListArgs(operation)
  }
}

function jsonArgs(...command: string[]): string[] {
  return [...command, '--output', 'json']
}

function buildIssueListArgs(
  operation: Extract<MulticaCliReadOperation, { kind: 'issue-list' }>
): string[] {
  const args = jsonArgs('issue', 'list')
  appendTextFlag(args, '--status', operation.status, 'issue status', 128)
  appendTextFlag(args, '--priority', operation.priority, 'issue priority', 128)
  appendTextFlag(args, '--assignee', operation.assignee, 'issue assignee', 256)
  appendTextFlag(args, '--project', operation.project, 'project ID', 256)
  appendIntegerFlag(args, '--limit', operation.limit, 1, 1000)
  appendIntegerFlag(args, '--offset', operation.offset, 0, 1_000_000)
  if (operation.sort !== undefined) {
    if (!SAFE_SORT.test(operation.sort)) {
      throw new Error('Invalid Multica issue sort expression')
    }
    args.push('--sort', operation.sort)
  }
  return args
}

function buildIssueSearchArgs(
  operation: Extract<MulticaCliReadOperation, { kind: 'issue-search' }>
): string[] {
  const args = [
    'issue',
    'search',
    requireSafeText(operation.query, 'issue search query', 4096),
    '--output',
    'json'
  ]
  appendIntegerFlag(args, '--limit', operation.limit, 1, 1000)
  if (operation.includeClosed) {
    args.push('--include-closed')
  }
  return args
}

function appendTextFlag(
  args: string[],
  flag: string,
  value: string | undefined,
  label: string,
  maxLength: number
): void {
  if (value !== undefined) {
    args.push(flag, requireSafeText(value, label, maxLength))
  }
}

function appendIntegerFlag(
  args: string[],
  flag: string,
  value: number | undefined,
  minimum: number,
  maximum: number
): void {
  if (value === undefined) {
    return
  }
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid Multica ${flag.slice(2)} value`)
  }
  args.push(flag, String(value))
}

function requireOpaqueIdentifier(value: string, label: string): string {
  const safe = requireSafeText(value, label, 256)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(safe)) {
    throw new Error(`Invalid Multica ${label}`)
  }
  return safe
}

function requireSafeText(value: string, label: string, maxLength: number): string {
  if (!value.trim() || value.length > maxLength || containsControlCharacter(value)) {
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

function requireHttpUrl(value: string): string {
  const safe = requireSafeText(value, 'server URL', 2048)
  let url: URL
  try {
    url = new URL(safe)
  } catch {
    throw new Error('Invalid Multica server URL')
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password
  ) {
    throw new Error('Invalid Multica server URL')
  }
  return safe
}
