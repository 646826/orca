import { createHash } from 'node:crypto'
import { resolveLificContext } from '../../shared/lific/lific-context'
import type {
  LificCommandRunner,
  LificConnectResult,
  LificConnectionProfile,
  LificHarnessBinding,
  LificHealthState,
  LificRepoBinding,
  LificSecretStore,
  LificWorkspaceBinding
} from '../../shared/lific/lific-types'
import { buildLificAgentsMdInvocation } from './lific-commands'
import { probeLificHealth } from './lific-connection-health'
import { NodeLificCommandRunner } from './lific-command-executor'
import { createExecutionHostRunner } from './lific-execution-host'
import { LificProvisioner } from './lific-provisioning'
import { LificRestClient } from './lific-rest-client'
import { OrcaLificSecretStore } from './lific-secret-store'
import { LificStateStore } from './lific-state-store'
import { LificTaskService } from './lific-task-service'

export type LificRuntimeServiceDeps = {
  executable?: string
  state?: LificStateStore
  secrets?: LificSecretStore
  runnerForProfile?: (profile: LificConnectionProfile) => LificCommandRunner
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export class LificRuntimeService {
  readonly #executable: string
  readonly #state: LificStateStore
  readonly #secrets: LificSecretStore
  readonly #runnerForProfile: (profile: LificConnectionProfile) => LificCommandRunner

  constructor(deps: LificRuntimeServiceDeps = {}) {
    this.#executable = deps.executable ?? process.env.ORCA_LIFIC_EXECUTABLE?.trim() ?? 'lific'
    this.#state = deps.state ?? new LificStateStore()
    this.#secrets = deps.secrets ?? new OrcaLificSecretStore()
    this.#runnerForProfile =
      deps.runnerForProfile ??
      ((profile) => {
        const localRunner = new NodeLificCommandRunner()
        const target = profile.executionTarget
        if (target?.kind === 'wsl') {
          return createExecutionHostRunner({
            host: {
              kind: 'wsl',
              id: target.id,
              distribution: target.distribution,
              helperCommand: target.helperCommand ?? 'orca-ide',
              helperArgs: ['lific', 'host-exec', '--envelope-stdin']
            },
            localRunner
          })
        }
        if (target?.kind === 'ssh') {
          return createExecutionHostRunner({
            host: {
              kind: 'ssh',
              id: target.id,
              host: target.host,
              ...(target.port ? { port: target.port } : {}),
              ...(target.identityFile ? { identityFile: target.identityFile } : {}),
              helperCommand: target.helperCommand ?? 'orca-ide',
              helperArgs: ['lific', 'host-exec', '--envelope-stdin']
            },
            localRunner
          })
        }
        if (target?.kind === 'runtime') {
          throw new Error(
            `Lific runtime target '${target.environmentId}' must be called through Orca runtime RPC so the command executes inside that runtime.`
          )
        }
        const currentHostId = process.env.ORCA_EXECUTION_HOST_ID?.trim() || 'local'
        const localAlias = currentHostId === 'local' && profile.executionHostId.startsWith('local')
        if (profile.executionHostId !== currentHostId && !localAlias) {
          throw new Error(
            `Lific profile '${profile.id}' belongs to ${profile.executionHostId}, but this runtime owns ${currentHostId}. Configure an explicit SSH/WSL/runtime runner instead of falling back locally.`
          )
        }
        return localRunner
      })
  }

  listProfiles(): LificConnectionProfile[] {
    return this.#state.read().profiles
  }

  async putProfile(profile: LificConnectionProfile): Promise<LificConnectionProfile> {
    await this.#state.putProfile(profile)
    return profile
  }

  async storeCredential(reference: string, value: string): Promise<{ stored: true }> {
    await this.#secrets.set(reference, value)
    return { stored: true }
  }

  async deleteCredential(reference: string): Promise<{ deleted: true }> {
    await this.#secrets.delete(reference)
    return { deleted: true }
  }

  async bindRepo(binding: LificRepoBinding): Promise<LificRepoBinding> {
    await this.#state.bindRepo(binding)
    return binding
  }

  async bindWorkspace(binding: LificWorkspaceBinding): Promise<LificWorkspaceBinding> {
    await this.#state.bindWorkspace(binding)
    return binding
  }

  context(input: {
    repoId: string
    workspaceId?: string
    agentProfileId: string
    executionHostId: string
  }): ReturnType<typeof resolveLificContext> {
    return resolveLificContext(this.#state.read(), input)
  }

  async status(
    profileId: string
  ): Promise<{ profile: LificConnectionProfile; state: LificHealthState }> {
    const profile = this.#profile(profileId)
    const credential = await this.#profileCredential(profile)
    const state = await probeLificHealth({
      profile,
      executable: this.#executable,
      ...(credential ? { credential } : {}),
      runner: this.#runnerForProfile(profile)
    })
    await this.#state.putProfile({
      ...profile,
      lastValidatedAt: Date.now(),
      lastValidationState: state
    })
    return { profile, state }
  }

  async connect(input: {
    profileId: string
    agent: string
    agentProfileId: string
    scope: 'global' | 'project'
    authentication: 'bot' | 'oauth'
    dryRun: boolean
    cwd?: string
  }): Promise<LificConnectResult> {
    const profile = this.#profile(input.profileId)
    const existing = this.#state
      .read()
      .harnessBindings.find(
        (entry) =>
          entry.connectionProfileId === profile.id && entry.agentProfileId === input.agentProfileId
      )
    if (existing && !input.dryRun) {
      throw new Error(
        `Lific harness '${input.agentProfileId}' is already configured. Use the explicit reconnect action to revoke and provision a replacement.`
      )
    }
    const provisioner = new LificProvisioner({
      executable: this.#executable,
      runner: this.#runnerForProfile(profile),
      secrets: this.#secrets,
      restFactory: (baseUrl, credential) => new LificRestClient({ baseUrl, credential })
    })
    const outcome = await provisioner.connect({ profile, ...input })
    if (!input.dryRun) {
      const binding: LificHarnessBinding = {
        connectionProfileId: profile.id,
        agentProfileId: input.agentProfileId,
        accessMode: outcome.accessMode,
        scope: input.scope,
        configuredAt: Date.now(),
        ...(outcome.clientId ? { clientId: outcome.clientId } : {}),
        ...(outcome.credentialRef ? { credentialRef: outcome.credentialRef } : {}),
        ...(outcome.botId !== undefined ? { botId: outcome.botId } : {}),
        ...(outcome.stdout ? { configFingerprint: fingerprint(outcome.stdout) } : {})
      }
      await this.#state.putHarness(binding)
    }
    return outcome
  }

  async reconnect(input: {
    profileId: string
    agent: string
    agentProfileId: string
    scope: 'global' | 'project'
    authentication: 'bot' | 'oauth'
    cwd?: string
  }): Promise<LificConnectResult> {
    await this.disconnect(input.profileId, input.agentProfileId)
    return this.connect({ ...input, dryRun: false })
  }

  async disconnect(profileId: string, agentProfileId: string): Promise<{ disconnected: true }> {
    const profile = this.#profile(profileId)
    const binding = this.#state
      .read()
      .harnessBindings.find(
        (entry) =>
          entry.connectionProfileId === profileId && entry.agentProfileId === agentProfileId
      )
    if (binding) {
      const provisioner = new LificProvisioner({
        executable: this.#executable,
        runner: this.#runnerForProfile(profile),
        secrets: this.#secrets,
        restFactory: (baseUrl, credential) => new LificRestClient({ baseUrl, credential })
      })
      await provisioner.disconnect({
        profile,
        ...(binding.credentialRef ? { credentialRef: binding.credentialRef } : {}),
        ...(binding.botId !== undefined ? { botId: binding.botId } : {})
      })
      await this.#state.removeHarness(profileId, agentProfileId)
    }
    return { disconnected: true }
  }

  async agentsMd(input: {
    profileId: string
    path: string
    projectIdentifier?: string
  }): Promise<{ changed: true; output: string }> {
    const profile = this.#profile(input.profileId)
    const result = await this.#runnerForProfile(profile).run(
      buildLificAgentsMdInvocation({
        executable: this.#executable,
        path: input.path,
        ...(input.projectIdentifier ? { project: input.projectIdentifier } : {})
      })
    )
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || 'Lific agents-md failed')
    }
    return { changed: true, output: result.stdout }
  }

  async taskClient(profileId: string): Promise<LificTaskService> {
    const profile = this.#profile(profileId)
    if (profile.transport.kind !== 'http') {
      throw new Error(
        'The native Lific Tasks provider requires an HTTP profile; stdio remains available to agents through MCP.'
      )
    }
    const credential = await this.#profileCredential(profile)
    if (!credential) {
      throw new Error('The native Lific Tasks provider requires a stored management credential')
    }
    return new LificTaskService(
      new LificRestClient({ baseUrl: profile.transport.baseUrl, credential })
    )
  }

  #profile(profileId: string): LificConnectionProfile {
    const profile = this.#state.read().profiles.find((entry) => entry.id === profileId)
    if (!profile) {
      throw new Error(`Unknown Lific connection profile '${profileId}'`)
    }
    return profile
  }

  async #profileCredential(profile: LificConnectionProfile): Promise<string | null> {
    if (profile.managementAuth.kind === 'local-instance') {
      return process.env.LIFIC_API_KEY?.trim() || null
    }
    return this.#secrets.get(profile.managementAuth.credentialRef)
  }
}

let singleton: LificRuntimeService | null = null

export function configureLificRuntimeService(service: LificRuntimeService): void {
  singleton = service
}

export function getLificRuntimeService(): LificRuntimeService {
  singleton ??= new LificRuntimeService()
  return singleton
}
