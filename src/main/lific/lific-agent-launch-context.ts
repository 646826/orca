import type { TuiAgent } from '../../shared/types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree-id'
import {
  buildAgentLaunchContext,
  resolveLificContext,
  resolveLificCredentialEnvironment
} from '../../shared/lific/lific-context'
import { OrcaLificSecretStore } from './lific-secret-store'
import { LificStateStore } from './lific-state-store'

export const LIFIC_AGENT_ENV_KEYS = [
  'ORCA_LIFIC_PROFILE',
  'ORCA_LIFIC_ACCESS_MODE',
  'ORCA_LIFIC_CLIENT',
  'ORCA_LIFIC_PROJECT',
  'ORCA_LIFIC_ISSUE',
  'ORCA_LIFIC_INSTRUCTION',
  'LIFIC_API_KEY'
] as const

/**
 * Add Lific context to a freshly spawned agent PTY. Non-secret binding data is
 * always eligible; an encrypted bearer key is decrypted only for a client such
 * as Codex whose native MCP schema explicitly names an environment variable.
 *
 * The lookup is synchronous because PTY environment construction is a
 * synchronous launch boundary. Every managed key is cleared first so a nested
 * Orca terminal cannot inherit another worktree's issue, profile, or credential.
 */
export function applyLificAgentLaunchEnv(
  env: Record<string, string>,
  input: {
    worktreeId?: string
    launchAgent?: TuiAgent
    executionHostId: string
    state?: LificStateStore
    secrets?: { getSync(reference: string): string | null }
  }
): void {
  for (const key of LIFIC_AGENT_ENV_KEYS) {
    delete env[key]
  }
  const worktreeId = input.worktreeId?.trim()
  if (!worktreeId || !input.launchAgent) {
    return
  }

  const state = input.state ?? new LificStateStore()
  const document = (() => {
    try {
      return state.read()
    } catch {
      // Why: terminal launch is a core path. Corrupt optional integration state
      // must fail closed instead of preventing every PTY from spawning.
      return null
    }
  })()
  if (!document) {
    return
  }
  const lookup = {
    repoId: getRepoIdFromWorktreeId(worktreeId),
    workspaceId: worktreeId,
    agentProfileId: input.launchAgent,
    executionHostId: input.executionHostId
  }
  const context = resolveLificContext(document, lookup)
  if (!context.ready) {
    return
  }

  const launch = buildAgentLaunchContext(context)
  Object.assign(env, launch.env)

  let secrets = input.secrets
  Object.assign(
    env,
    resolveLificCredentialEnvironment(document, lookup, (reference) => {
      secrets ??= new OrcaLificSecretStore()
      return secrets.getSync(reference)
    })
  )
}

export function resolveLificPtyExecutionHostId(input: {
  isWsl?: boolean
  wslDistro?: string | null
  runtimeHostId?: string | null
}): string {
  if (input.isWsl) {
    return `wsl:${input.wslDistro?.trim() || 'default'}`
  }
  return input.runtimeHostId?.trim() || 'local'
}
