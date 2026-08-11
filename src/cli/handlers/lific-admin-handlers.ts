import { readFileSync } from 'node:fs'
import type { LificConnectionProfile } from '../../shared/lific/lific-types'
import { decodeHostExecutionEnvelope } from '../../shared/lific/lific-host-envelope'
import { isAllowedLificExecutable } from '../../shared/lific/lific-host-exec-policy'
import { runLificHostCommand } from './lific-host-command-runner'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { formatLificResult, requireLificStdin } from './lific-handler-utils'

export const LIFIC_ADMIN_HANDLER_ENTRIES: Record<string, CommandHandler> = {
  'lific host-exec': async ({ flags }) => {
    if (flags.get('envelope-stdin') !== true) {
      throw new Error('Expected --envelope-stdin')
    }
    const encoded = readFileSync(0, 'utf8').trim()
    if (!encoded || encoded.length > 2 * 1024 * 1024) {
      throw new Error('Invalid or oversized Lific execution envelope')
    }
    const invocation = decodeHostExecutionEnvelope(encoded)
    if (
      !isAllowedLificExecutable(
        invocation.command,
        process.env.ORCA_LIFIC_EXECUTABLE?.trim() || 'lific'
      )
    ) {
      throw new Error('The Lific host executor only accepts the configured lific executable')
    }
    const result = runLificHostCommand(invocation)
    if (result.stdout) {
      process.stdout.write(result.stdout)
    }
    if (result.stderr) {
      process.stderr.write(result.stderr)
    }
    if (result.exitCode !== 0) {
      process.exitCode = result.exitCode ?? 1
    }
  },
  'lific profiles': async ({ client, json }) => {
    printResult(await client.call('lific.profiles'), json, formatLificResult)
  },
  'lific profile put': async ({ flags, client, json }) => {
    const id = getRequiredStringFlag(flags, 'id')
    const baseUrl = getOptionalStringFlag(flags, 'url')
    const databasePath = getOptionalStringFlag(flags, 'db')
    if ((baseUrl ? 1 : 0) + (databasePath ? 1 : 0) !== 1) {
      throw new Error('Use exactly one of --url or --db')
    }
    const credentialRef = getOptionalStringFlag(flags, 'credential-ref')
    const sshIdentityFile = getOptionalStringFlag(flags, 'ssh-identity-file')
    const executionHostId = getRequiredStringFlag(flags, 'host')
    const targetKind = getOptionalStringFlag(flags, 'target') ?? 'current'
    if (!['current', 'wsl', 'ssh'].includes(targetKind)) {
      throw new Error('--target must be current, wsl, or ssh')
    }
    const sshPortRaw = getOptionalStringFlag(flags, 'ssh-port')
    const sshPort = sshPortRaw ? Number(sshPortRaw) : undefined
    if (sshPort !== undefined && (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535)) {
      throw new Error('--ssh-port must be an integer from 1 to 65535')
    }
    const profile: LificConnectionProfile = {
      id,
      executionHostId,
      displayName: getRequiredStringFlag(flags, 'name'),
      transport: baseUrl
        ? {
            kind: 'http',
            baseUrl,
            mcpUrl: getOptionalStringFlag(flags, 'mcp-url') ?? `${baseUrl.replace(/\/+$/, '')}/mcp`
          }
        : { kind: 'stdio', databasePath: databasePath as string },
      managementAuth: credentialRef
        ? { kind: 'external-key', credentialRef }
        : { kind: 'local-instance' },
      executionTarget:
        targetKind === 'wsl'
          ? {
              kind: 'wsl',
              id: executionHostId,
              distribution: getRequiredStringFlag(flags, 'wsl-distro')
            }
          : targetKind === 'ssh'
            ? {
                kind: 'ssh',
                id: executionHostId,
                connectionId: getOptionalStringFlag(flags, 'connection-id') ?? executionHostId,
                host: getRequiredStringFlag(flags, 'ssh-host'),
                ...(sshPort ? { port: sshPort } : {}),
                ...(sshIdentityFile ? { identityFile: sshIdentityFile } : {})
              }
            : { kind: 'local', id: executionHostId },
      managedByOrca: true
    }
    printResult(await client.call('lific.profile.put', { profile }), json, formatLificResult)
  },
  'lific credential store': async ({ flags, client, json }) => {
    const credentialRef = getRequiredStringFlag(flags, 'ref')
    printResult(
      await client.call('lific.credential.store', {
        credentialRef,
        value: requireLificStdin(flags)
      }),
      json,
      formatLificResult
    )
  },
  'lific credential delete': async ({ flags, client, json }) => {
    printResult(
      await client.call('lific.credential.delete', {
        credentialRef: getRequiredStringFlag(flags, 'ref')
      }),
      json,
      formatLificResult
    )
  },
  'lific status': async ({ flags, client, json }) => {
    printResult(
      await client.call(
        'lific.status',
        { profileId: getRequiredStringFlag(flags, 'profile') },
        { timeoutMs: 120_000 }
      ),
      json,
      formatLificResult
    )
  },
  'lific bind-repo': async ({ flags, client, json }) => {
    printResult(
      await client.call('lific.repo.bind', {
        repoId: getRequiredStringFlag(flags, 'repo'),
        connectionProfileId: getRequiredStringFlag(flags, 'profile'),
        projectIdentifier: getOptionalStringFlag(flags, 'project'),
        agentsMdMode: 'offer'
      }),
      json,
      formatLificResult
    )
  },
  'lific bind-workspace': async ({ flags, client, json }) => {
    printResult(
      await client.call('lific.workspace.bind', {
        workspaceId: getRequiredStringFlag(flags, 'workspace'),
        issueIdentifier: getRequiredStringFlag(flags, 'issue')
      }),
      json,
      formatLificResult
    )
  },
  'lific context': async ({ flags, client, json }) => {
    printResult(
      await client.call('lific.context', {
        repoId: getRequiredStringFlag(flags, 'repo'),
        workspaceId: getOptionalStringFlag(flags, 'workspace'),
        agentProfileId: getRequiredStringFlag(flags, 'agent-profile'),
        executionHostId: getRequiredStringFlag(flags, 'host')
      }),
      json,
      formatLificResult
    )
  },
  'lific connect': async ({ flags, client, cwd, json }) => {
    const agent = getRequiredStringFlag(flags, 'agent')
    const scope = getOptionalStringFlag(flags, 'scope') ?? 'global'
    if (scope !== 'global' && scope !== 'project') {
      throw new Error('--scope must be global or project')
    }
    printResult(
      await client.call(
        'lific.connect',
        {
          profileId: getRequiredStringFlag(flags, 'profile'),
          agent,
          agentProfileId: getOptionalStringFlag(flags, 'agent-profile') ?? agent,
          scope,
          authentication: flags.get('oauth') === true ? 'oauth' : 'bot',
          dryRun: flags.get('dry-run') === true,
          cwd
        },
        { timeoutMs: 120_000 }
      ),
      json,
      formatLificResult
    )
  },
  'lific reconnect': async ({ flags, client, cwd, json }) => {
    const agent = getRequiredStringFlag(flags, 'agent')
    const scope = getOptionalStringFlag(flags, 'scope') ?? 'global'
    if (scope !== 'global' && scope !== 'project') {
      throw new Error('--scope must be global or project')
    }
    printResult(
      await client.call(
        'lific.reconnect',
        {
          profileId: getRequiredStringFlag(flags, 'profile'),
          agent,
          agentProfileId: getOptionalStringFlag(flags, 'agent-profile') ?? agent,
          scope,
          authentication: flags.get('oauth') === true ? 'oauth' : 'bot',
          cwd
        },
        { timeoutMs: 120_000 }
      ),
      json,
      formatLificResult
    )
  },
  'lific disconnect': async ({ flags, client, json }) => {
    printResult(
      await client.call(
        'lific.disconnect',
        {
          profileId: getRequiredStringFlag(flags, 'profile'),
          agentProfileId: getRequiredStringFlag(flags, 'agent-profile')
        },
        { timeoutMs: 120_000 }
      ),
      json,
      formatLificResult
    )
  },
  'lific agents-md': async ({ flags, client, json }) => {
    printResult(
      await client.call('lific.agentsMd', {
        profileId: getRequiredStringFlag(flags, 'profile'),
        path: getRequiredStringFlag(flags, 'path'),
        projectIdentifier: getOptionalStringFlag(flags, 'project')
      }),
      json,
      formatLificResult
    )
  }
}
