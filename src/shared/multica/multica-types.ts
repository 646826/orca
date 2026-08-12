export type ExecutionHostId = string

export type MulticaExecutionTarget =
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

export type MulticaCliFallback = {
  executable: string
  profileName?: string
}

export type MulticaDataPlane =
  | {
      kind: 'rest'
      serverUrl: string
      appUrl?: string
      credentialRef: string
      cliFallback?: MulticaCliFallback
    }
  | {
      kind: 'cli'
      executable: string
      profileName?: string
      serverUrl?: string
      credentialRef?: string
    }

export type MulticaInstanceLifecycle =
  | { kind: 'external' }
  | {
      kind: 'docker-compose'
      workingDirectory: string
      composeFiles: string[]
      environmentFile?: string
      projectName?: string
      pullBeforeStart: boolean
    }

export type MulticaCapability =
  | 'workspaces'
  | 'projects'
  | 'issues'
  | 'comments'
  | 'runs'
  | 'agents'
  | 'squads'
  | 'skills'
  | 'runtimes'
  | 'assignments'
  | 'issue-metadata'
  | 'realtime'
  | 'managed-lifecycle'

export type MulticaHealthState =
  | { kind: 'not-installed' }
  | { kind: 'compose-unavailable'; message: string }
  | { kind: 'not-running' }
  | { kind: 'unsupported-version'; message: string; detectedVersion?: string }
  | { kind: 'unreachable'; message: string }
  | { kind: 'authentication-failed'; message: string }
  | { kind: 'workspace-not-found'; workspaceId: string }
  | {
      kind: 'ready'
      checkedAt: number
      serverVersion?: string
      cliVersion?: string
      capabilities: MulticaCapability[]
    }

export type MulticaConnectionProfile = {
  id: string
  displayName: string
  executionHostId: ExecutionHostId
  executionTarget?: MulticaExecutionTarget
  dataPlane: MulticaDataPlane
  lifecycle: MulticaInstanceLifecycle
  managedByOrca: boolean
  defaultWorkspaceId?: string
  lastValidatedAt?: number
  lastValidationState?: MulticaHealthState
}

export type MulticaSyncPolicy = {
  comments: boolean
  issueStatus: boolean
  runMetadata: boolean
}

export type MulticaExecutionPolicy =
  | { owner: 'multica'; assigneeId: string; assigneeType: 'agent' | 'squad' }
  | { owner: 'orca'; agentProfileId: string; sync: MulticaSyncPolicy }
  | { owner: 'manual' }

export type MulticaRepoBinding = {
  repoId: string
  connectionProfileId: string
  multicaWorkspaceId?: string
  projectId?: string
}

export type MulticaWorkspaceBinding = {
  workspaceId: string
  connectionProfileId: string
  issueId: string
  issueKey?: string
  executionPolicy?: MulticaExecutionPolicy
}

export type MulticaSkillReceipt = {
  direction: 'orca-to-multica' | 'multica-to-orca'
  sourceId: string
  targetId?: string
  sourceDigest?: string
  targetDigest?: string
  synchronizedAt?: number
}

export type MulticaState = {
  schemaVersion: 1
  profiles: MulticaConnectionProfile[]
  repoBindings: MulticaRepoBinding[]
  workspaceBindings: MulticaWorkspaceBinding[]
  skillReceipts: MulticaSkillReceipt[]
}

export type MulticaProfileInput = Omit<
  MulticaConnectionProfile,
  'lastValidatedAt' | 'lastValidationState'
>
