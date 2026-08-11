import type { GlobalSettings } from '../../../shared/types'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type {
  LificActivityFeed,
  LificComment,
  LificConnectResult,
  LificConnectionProfile,
  LificHealthState,
  LificIssue,
  LificPage,
  LificPlan,
  LificProject,
  LificSearchResult,
  LificRepoBinding,
  LificWorkspaceBinding,
  ResolvedLificContext
} from '../../../shared/lific/lific-types'
import {
  LIFIC_PROVISIONING_RUNTIME_CAPABILITY,
  LIFIC_TASK_PROVIDER_RUNTIME_CAPABILITY
} from '../../../shared/lific/lific-rpc-contract'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  runtimeEnvironmentSupportsCapability
} from './runtime-rpc-client'

export type RuntimeLificSettings =
  | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  | TaskSourceContext
  | null
  | undefined

function target(settings: RuntimeLificSettings) {
  return getActiveRuntimeTarget(
    settings && 'kind' in settings ? getTaskSourceRuntimeSettings(settings) : settings
  )
}

async function ensureCapability(
  settings: RuntimeLificSettings,
  capability: string,
  message: string
): Promise<void> {
  const next = target(settings)
  if (
    next.kind === 'environment' &&
    !(await runtimeEnvironmentSupportsCapability(next.environmentId, capability, 30_000))
  ) {
    throw new Error(message)
  }
}

export async function lificProfiles(
  settings: RuntimeLificSettings
): Promise<LificConnectionProfile[]> {
  await ensureCapability(
    settings,
    LIFIC_PROVISIONING_RUNTIME_CAPABILITY,
    'This remote Orca runtime must be updated before Lific can be configured.'
  )
  return callRuntimeRpc<LificConnectionProfile[]>(target(settings), 'lific.profiles', undefined, {
    timeoutMs: 30_000
  })
}

export async function lificPutProfile(
  settings: RuntimeLificSettings,
  profile: LificConnectionProfile
): Promise<LificConnectionProfile> {
  return callRuntimeRpc(target(settings), 'lific.profile.put', { profile }, { timeoutMs: 30_000 })
}

export async function lificStoreCredential(
  settings: RuntimeLificSettings,
  credentialRef: string,
  value: string
): Promise<{ stored: true }> {
  return callRuntimeRpc(
    target(settings),
    'lific.credential.store',
    { credentialRef, value },
    { timeoutMs: 30_000 }
  )
}

export async function lificBindRepo(
  settings: RuntimeLificSettings,
  binding: LificRepoBinding
): Promise<LificRepoBinding> {
  return callRuntimeRpc(target(settings), 'lific.repo.bind', binding, { timeoutMs: 30_000 })
}

export async function lificBindWorkspace(
  settings: RuntimeLificSettings,
  binding: LificWorkspaceBinding
): Promise<LificWorkspaceBinding> {
  return callRuntimeRpc(target(settings), 'lific.workspace.bind', binding, { timeoutMs: 30_000 })
}

export async function lificContext(
  settings: RuntimeLificSettings,
  input: {
    repoId: string
    workspaceId?: string
    agentProfileId: string
    executionHostId: string
  }
): Promise<ResolvedLificContext> {
  return callRuntimeRpc(target(settings), 'lific.context', input, { timeoutMs: 30_000 })
}

export async function lificStatus(
  settings: RuntimeLificSettings,
  profileId: string
): Promise<{ profile: LificConnectionProfile; state: LificHealthState }> {
  return callRuntimeRpc(target(settings), 'lific.status', { profileId }, { timeoutMs: 120_000 })
}

export async function lificConnect(
  settings: RuntimeLificSettings,
  input: {
    profileId: string
    agent: string
    agentProfileId: string
    scope: 'global' | 'project'
    authentication: 'bot' | 'oauth'
    dryRun: boolean
    cwd?: string
  }
): Promise<LificConnectResult> {
  return callRuntimeRpc(target(settings), 'lific.connect', input, { timeoutMs: 120_000 })
}

export async function lificReconnect(
  settings: RuntimeLificSettings,
  input: {
    profileId: string
    agent: string
    agentProfileId: string
    scope: 'global' | 'project'
    authentication: 'bot' | 'oauth'
    cwd?: string
  }
): Promise<LificConnectResult> {
  return callRuntimeRpc(
    target(settings),
    'lific.reconnect',
    { ...input, dryRun: false },
    {
      timeoutMs: 120_000
    }
  )
}

export async function lificDisconnect(
  settings: RuntimeLificSettings,
  profileId: string,
  agentProfileId: string
): Promise<{ disconnected: true }> {
  return callRuntimeRpc(
    target(settings),
    'lific.disconnect',
    { profileId, agentProfileId },
    { timeoutMs: 120_000 }
  )
}

export async function lificAgentsMd(
  settings: RuntimeLificSettings,
  input: { profileId: string; path: string; projectIdentifier?: string }
): Promise<{ changed: true; output: string }> {
  return callRuntimeRpc(target(settings), 'lific.agentsMd', input, { timeoutMs: 60_000 })
}

async function taskCall<TResult>(
  settings: RuntimeLificSettings,
  method: string,
  params: unknown
): Promise<TResult> {
  await ensureCapability(
    settings,
    LIFIC_TASK_PROVIDER_RUNTIME_CAPABILITY,
    'This remote Orca runtime must be updated before Lific Tasks can be used.'
  )
  return callRuntimeRpc<TResult>(target(settings), method, params, { timeoutMs: 60_000 })
}

export const lificTaskProjects = (
  settings: RuntimeLificSettings,
  profileId: string
): Promise<LificProject[]> => taskCall(settings, 'lific.task.projects', { profileId })

export const lificTaskIssues = (
  settings: RuntimeLificSettings,
  input: { profileId: string; project: string; query?: string; limit?: number }
): Promise<LificIssue[]> => taskCall(settings, 'lific.task.issues', input)

export const lificTaskIssue = (
  settings: RuntimeLificSettings,
  profileId: string,
  identifier: string
): Promise<LificIssue> => taskCall(settings, 'lific.task.issue', { profileId, identifier })

export const lificTaskUpdateIssue = (
  settings: RuntimeLificSettings,
  input: { profileId: string; identifier: string; update: Record<string, unknown> }
): Promise<LificIssue> => taskCall(settings, 'lific.task.issue.update', input)

export const lificTaskComments = (
  settings: RuntimeLificSettings,
  profileId: string,
  identifier: string
): Promise<LificComment[]> => taskCall(settings, 'lific.task.comments', { profileId, identifier })

export const lificTaskAddComment = (
  settings: RuntimeLificSettings,
  input: { profileId: string; identifier: string; content: string }
): Promise<LificComment> => taskCall(settings, 'lific.task.comment.add', input)

export const lificTaskPlans = (
  settings: RuntimeLificSettings,
  input: { profileId: string; projectId: number; status?: string }
): Promise<LificPlan[]> => taskCall(settings, 'lific.task.plans', input)

export const lificTaskPlan = (
  settings: RuntimeLificSettings,
  profileId: string,
  identifier: string
): Promise<LificPlan> => taskCall(settings, 'lific.task.plan', { profileId, identifier })

export const lificTaskUpdatePlanStep = (
  settings: RuntimeLificSettings,
  input: {
    profileId: string
    planId: number
    stepId: number
    update: Record<string, unknown>
  }
): Promise<LificPlan> => taskCall(settings, 'lific.task.plan-step.update', input)

export const lificTaskActivity = (
  settings: RuntimeLificSettings,
  input: { profileId: string; projectId: number; limit?: number }
): Promise<LificActivityFeed> => taskCall(settings, 'lific.task.activity', input)

export const lificTaskSearch = (
  settings: RuntimeLificSettings,
  input: {
    profileId: string
    query: string
    projectId?: number
    resultType?: 'issue' | 'page'
    limit?: number
  }
): Promise<LificSearchResult[]> => taskCall(settings, 'lific.task.search', input)

export const lificTaskPages = (
  settings: RuntimeLificSettings,
  profileId: string,
  projectId: number
): Promise<LificPage[]> => taskCall(settings, 'lific.task.pages', { profileId, projectId })

export const lificTaskPage = (
  settings: RuntimeLificSettings,
  profileId: string,
  identifier: string
): Promise<LificPage> => taskCall(settings, 'lific.task.page', { profileId, identifier })

export const lificTaskBoard = (
  settings: RuntimeLificSettings,
  profileId: string,
  projectId: number
): Promise<Record<string, unknown>> =>
  taskCall(settings, 'lific.task.board', { profileId, projectId })

export const lificTaskLinkIssues = (
  settings: RuntimeLificSettings,
  input: { profileId: string; source: string; target: string; relation: string }
): Promise<{ linked: true }> => taskCall(settings, 'lific.task.relation.link', input)

export const lificTaskUnlinkIssues = (
  settings: RuntimeLificSettings,
  input: { profileId: string; source: string; target: string; relation: string }
): Promise<{ unlinked: true }> => taskCall(settings, 'lific.task.relation.unlink', input)
