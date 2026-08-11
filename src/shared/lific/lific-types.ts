export type ExecutionHostId = string
export type LificClientId =
  | 'opencode'
  | 'claude-code'
  | 'claude-desktop'
  | 'cursor'
  | 'vscode'
  | 'codex'
  | 'zed'
  | 'gemini'
  | 'windsurf'
  | 'goose'
  | 'crush'

export type LificScope = 'global' | 'project'
export type LificAccessMode = 'mcp' | 'cli'

export type LificTransport =
  | { kind: 'stdio'; databasePath: string }
  | { kind: 'http'; baseUrl: string; mcpUrl: string }

export type LificManagementAuth =
  | { kind: 'local-instance' }
  | { kind: 'stored-oauth'; credentialRef: string }
  | { kind: 'external-key'; credentialRef: string }

/** Where the Lific binary and client configuration are owned. */
export type LificExecutionTarget =
  | { kind: 'local'; id: string }
  | { kind: 'wsl'; id: string; distribution: string; helperCommand?: string }
  | {
      kind: 'ssh'
      id: string
      connectionId: string
      host: string
      port?: number
      identityFile?: string
      helperCommand?: string
    }
  | { kind: 'runtime'; id: string; environmentId: string }

export type LificHealthState =
  | { kind: 'not-installed' }
  | { kind: 'unsupported-version'; message: string }
  | { kind: 'not-initialized' }
  | { kind: 'not-configured' }
  | { kind: 'unreachable'; message: string }
  | { kind: 'authentication-failed'; message: string }
  | { kind: 'unsupported-agent'; agent: string }
  | { kind: 'ready'; checkedAt: number }

export type LificConnectionProfile = {
  id: string
  executionHostId: ExecutionHostId
  displayName: string
  transport: LificTransport
  managementAuth: LificManagementAuth
  executionTarget?: LificExecutionTarget
  managedByOrca: boolean
  lastValidatedAt?: number
  lastValidationState?: LificHealthState
}

export type LificRepoBinding = {
  repoId: string
  connectionProfileId: string
  projectIdentifier?: string
  agentsMdMode: 'off' | 'offer' | 'managed'
}

export type LificHarnessBinding = {
  connectionProfileId: string
  agentProfileId: string
  accessMode: LificAccessMode
  clientId?: LificClientId
  scope: LificScope
  credentialRef?: string
  configuredAt?: number
  configFingerprint?: string
  botId?: number
}

export type LificWorkspaceBinding = {
  workspaceId: string
  issueIdentifier: string
}

export type LificState = {
  schemaVersion: 1
  profiles: LificConnectionProfile[]
  repoBindings: LificRepoBinding[]
  harnessBindings: LificHarnessBinding[]
  workspaceBindings: LificWorkspaceBinding[]
}

export type ResolvedLificContext = {
  ready: boolean
  reason?:
    | 'repo-not-bound'
    | 'profile-not-found'
    | 'execution-host-mismatch'
    | 'harness-not-configured'
  connectionProfileId?: string
  transportKind?: LificTransport['kind']
  projectIdentifier?: string
  issueIdentifier?: string
  accessMode?: LificAccessMode
  clientId?: LificClientId
}

export type ProcessInvocation = {
  command: string
  args: string[]
  shell: false
  env?: Record<string, string>
  cwd?: string
  stdin?: string
}

export type ProcessFailure = {
  command: string
  args: string[]
  stdout: string
  stderr: string
  exitCode: number | null
}

export type LificProject = {
  id: number
  identifier: string
  name: string
  description?: string
}

export type LificIssue = {
  id: number
  identifier: string
  title: string
  status?: string
  priority?: string | number | null
  description?: string | null
  projectId?: number
  url?: string
  raw: Record<string, unknown>
}

export type LificComment = {
  id: number
  content: string
  createdAt?: string
  raw: Record<string, unknown>
}

export type LificBot = {
  id: number
  username: string
  displayName: string
}

export type LificBotConnection = {
  bot: LificBot
  key: string
  tool: LificClientId
}

export type ProcessResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  errorCode?: string
}

export type LificCommandRunner = {
  run(invocation: ProcessInvocation): Promise<ProcessResult>
}

export type LificSecretStore = {
  get(reference: string): Promise<string | null>
  set(reference: string, value: string): Promise<void>
  delete(reference: string): Promise<void>
}

export type LificPlanStep = {
  id: number
  title: string
  description?: string
  done: boolean
  issueId?: number | null
  parentStepId?: number | null
  children: LificPlanStep[]
  raw: Record<string, unknown>
}

export type LificPlan = {
  id: number
  identifier: string
  projectId: number
  title: string
  status: string
  description?: string | null
  steps: LificPlanStep[]
  raw: Record<string, unknown>
}

export type LificActivity = {
  id: number
  timestamp: string
  action: string
  entityType: string
  entityId: number
  actorUsername?: string | null
  actorIsBot: boolean
  transport: string
  raw: Record<string, unknown>
}

export type LificActivityFeed = {
  items: LificActivity[]
  hasMore: boolean
}

export type LificPage = {
  id: number
  identifier: string
  title: string
  content?: string
  projectId?: number
  raw: Record<string, unknown>
}

export type LificSearchResult = {
  resultType: string
  id: number
  identifier?: string | null
  title: string
  snippet: string
  projectId?: number | null
  raw: Record<string, unknown>
}

export type LificProfileInput = Omit<
  LificConnectionProfile,
  'lastValidatedAt' | 'lastValidationState'
>

export type LificConnectRequest = {
  profileId: string
  agent: string
  agentProfileId: string
  scope: LificScope
  authentication: 'bot' | 'oauth'
  dryRun: boolean
  cwd?: string
}

export type LificConnectResult = {
  accessMode: LificAccessMode
  clientId?: LificClientId
  credentialRef?: string
  botId?: number
  changed: boolean
  preview: boolean
  stdout?: string
}

export type LificRuntimeStatus = {
  profile: LificConnectionProfile
  state: LificHealthState
}
