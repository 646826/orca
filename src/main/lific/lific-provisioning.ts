import { resolveLificClientForAgent } from '../../shared/lific/lific-client-registry'
import { buildLificConnectInvocation } from './lific-commands'
import { sanitizeProcessFailure } from '../../shared/lific/lific-redaction'
import type {
  LificAccessMode,
  LificBotConnection,
  LificClientId,
  LificCommandRunner,
  LificConnectionProfile,
  LificScope,
  LificSecretStore,
  ProcessResult
} from '../../shared/lific/lific-types'

export type LificBotApi = {
  createBot(tool: LificClientId): Promise<LificBotConnection>
  disconnectBot(id: number): Promise<void>
}

export type LificConnectOutcome = {
  accessMode: LificAccessMode
  clientId?: LificClientId
  credentialRef?: string
  changed: boolean
  preview: boolean
  stdout?: string
  botId?: number
}

export class LificProvisioner {
  readonly #executable: string
  readonly #runner: LificCommandRunner
  readonly #secrets: LificSecretStore
  readonly #restFactory: (baseUrl: string, credential: string) => LificBotApi

  constructor(input: {
    executable: string
    runner: LificCommandRunner
    secrets: LificSecretStore
    restFactory: (baseUrl: string, credential: string) => LificBotApi
  }) {
    this.#executable = input.executable
    this.#runner = input.runner
    this.#secrets = input.secrets
    this.#restFactory = input.restFactory
  }

  async connect(input: {
    profile: LificConnectionProfile
    agent: string
    agentProfileId: string
    scope: LificScope
    dryRun: boolean
    authentication?: 'bot' | 'oauth'
    cwd?: string
  }): Promise<LificConnectOutcome> {
    const clientId = resolveLificClientForAgent(input.agent)
    if (!clientId) {
      return { accessMode: 'cli', changed: false, preview: input.dryRun }
    }

    if (input.profile.transport.kind === 'http' && input.authentication === 'oauth') {
      const invocation = buildLificConnectInvocation({
        executable: this.#executable,
        clientId,
        scope: input.scope,
        transport: input.profile.transport,
        oauth: true,
        configOnly: true,
        dryRun: input.dryRun,
        ...(input.cwd ? { cwd: input.cwd } : {})
      })
      const result = await this.#runner.run(invocation)
      this.#throwOnFailure(result, invocation.command, invocation.args)
      return {
        accessMode: 'mcp',
        clientId,
        changed: !input.dryRun,
        preview: input.dryRun,
        stdout: result.stdout
      }
    }

    if (input.profile.transport.kind === 'stdio') {
      const invocation = buildLificConnectInvocation({
        executable: this.#executable,
        clientId,
        scope: input.scope,
        transport: input.profile.transport,
        dryRun: input.dryRun,
        ...(input.cwd ? { cwd: input.cwd } : {})
      })
      const result = await this.#runner.run(invocation)
      this.#throwOnFailure(result, invocation.command, invocation.args)
      return {
        accessMode: 'mcp',
        clientId,
        changed: !input.dryRun,
        preview: input.dryRun,
        stdout: result.stdout
      }
    }

    if (input.dryRun) {
      const invocation = buildLificConnectInvocation({
        executable: this.#executable,
        clientId,
        scope: input.scope,
        transport: input.profile.transport,
        provisionedKey: 'lific_dry_run_placeholder',
        configOnly: true,
        dryRun: true,
        ...(input.cwd ? { cwd: input.cwd } : {})
      })
      const result = await this.#runner.run(invocation)
      this.#throwOnFailure(result, invocation.command, invocation.args)
      return {
        accessMode: 'mcp',
        clientId,
        changed: false,
        preview: true,
        stdout: result.stdout
      }
    }

    const managementRef =
      input.profile.managementAuth.kind === 'local-instance'
        ? null
        : input.profile.managementAuth.credentialRef
    if (!managementRef) {
      throw new Error('Remote Lific provisioning requires stored management authentication')
    }
    const ownerCredential = await this.#secrets.get(managementRef)
    if (!ownerCredential) {
      throw new Error(`Missing Lific management credential '${managementRef}'`)
    }

    const api = this.#restFactory(input.profile.transport.baseUrl, ownerCredential)
    const created = await api.createBot(clientId)
    const credentialRef = `lific:${input.profile.id}:${input.agentProfileId}`
    try {
      await this.#secrets.set(credentialRef, created.key)
      const invocation = buildLificConnectInvocation({
        executable: this.#executable,
        clientId,
        scope: input.scope,
        transport: input.profile.transport,
        provisionedKey: created.key,
        configOnly: true,
        dryRun: false,
        ...(input.cwd ? { cwd: input.cwd } : {})
      })
      const result = await this.#runner.run(invocation)
      this.#throwOnFailure(result, invocation.command, invocation.args)
      return {
        accessMode: 'mcp',
        clientId,
        credentialRef,
        botId: created.bot.id,
        changed: true,
        preview: false,
        stdout: result.stdout
      }
    } catch (error) {
      const compensation = await Promise.allSettled([
        this.#secrets.delete(credentialRef),
        api.disconnectBot(created.bot.id)
      ])
      const compensationErrors = compensation.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (compensationErrors.length > 0) {
        const message = error instanceof Error ? error.message : String(error)
        throw new AggregateError(
          [error, ...compensationErrors],
          `Lific provisioning failed and compensation was incomplete: ${message}`
        )
      }
      throw error
    }
  }

  async disconnect(input: {
    profile: LificConnectionProfile
    credentialRef?: string
    botId?: number
  }): Promise<void> {
    if (input.profile.transport.kind === 'http' && input.botId !== undefined) {
      const managementRef =
        input.profile.managementAuth.kind === 'local-instance'
          ? null
          : input.profile.managementAuth.credentialRef
      if (!managementRef) {
        throw new Error('Remote Lific disconnect requires stored management authentication')
      }
      const ownerCredential = await this.#secrets.get(managementRef)
      if (!ownerCredential) {
        throw new Error(`Missing Lific management credential '${managementRef}'`)
      }
      await this.#restFactory(input.profile.transport.baseUrl, ownerCredential).disconnectBot(
        input.botId
      )
    }
    if (input.credentialRef) {
      await this.#secrets.delete(input.credentialRef)
    }
  }

  #throwOnFailure(result: ProcessResult, command: string, args: string[]): void {
    if (result.exitCode === 0) {
      return
    }
    const safe = sanitizeProcessFailure({ command, args, ...result })
    throw new Error(
      safe.stderr || safe.stdout || `Lific command failed with exit code ${safe.exitCode}`
    )
  }
}
