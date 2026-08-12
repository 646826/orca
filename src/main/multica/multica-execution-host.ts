import {
  decodeMulticaHostEnvelope,
  encodeMulticaHostEnvelope,
  type MulticaProcessInvocation,
  type MulticaProcessResult
} from '../../shared/multica/multica-host-envelope'
import type {
  MulticaConnectionProfile,
  MulticaExecutionTarget
} from '../../shared/multica/multica-types'

export type MulticaProcessExecutor = (
  invocation: MulticaProcessInvocation
) => Promise<MulticaProcessResult>

export type MulticaRuntimeProcessExecutor = (
  environmentId: string,
  invocation: MulticaProcessInvocation
) => Promise<MulticaProcessResult>

export type MulticaExecutionHostErrorCode =
  | 'execution-host-mismatch'
  | 'runtime-executor-unavailable'
  | 'invalid-execution-target'

export class MulticaExecutionHostError extends Error {
  readonly code: MulticaExecutionHostErrorCode

  constructor(code: MulticaExecutionHostErrorCode, message: string) {
    super(message)
    this.name = 'MulticaExecutionHostError'
    this.code = code
  }
}

export type RunMulticaOnExecutionHostInput = {
  profile: MulticaConnectionProfile
  invocation: MulticaProcessInvocation
  executeLocal: MulticaProcessExecutor
  executeRuntime?: MulticaRuntimeProcessExecutor
  currentHostId?: string
}

type RemoteShellTarget = Extract<
  MulticaExecutionTarget,
  { kind: 'wsl' | 'ssh' }
>

const DEFAULT_HELPER_COMMAND = 'orca-ide'
const HELPER_ARGS = ['multica', 'host-exec', '--envelope-stdin'] as const
const TARGET_TEXT_MAX_CHARS = 4096
const SAFE_REMOTE_HELPER = /^[A-Za-z0-9_./-]+$/

export async function runMulticaOnExecutionHost(
  input: RunMulticaOnExecutionHostInput
): Promise<MulticaProcessResult> {
  const invocation = validateInvocation(input.invocation)
  const target = input.profile.executionTarget

  if (!target) {
    assertCurrentHostOwnership(
      input.profile,
      resolveCurrentHostId(input.currentHostId)
    )
    return await input.executeLocal(invocation)
  }
  assertTargetOwnership(input.profile, target)

  switch (target.kind) {
    case 'local':
      assertCurrentHostOwnership(
        input.profile,
        resolveCurrentHostId(input.currentHostId)
      )
      return await input.executeLocal(invocation)
    case 'wsl':
    case 'ssh':
      return await input.executeLocal(
        validateInvocation(wrapMulticaInvocationForExecutionTarget(invocation, target))
      )
    case 'runtime':
      if (!input.executeRuntime) {
        throw new MulticaExecutionHostError(
          'runtime-executor-unavailable',
          'Multica runtime execution requires an explicit Orca runtime executor'
        )
      }
      return await input.executeRuntime(
        requireTargetText(target.environmentId, 'runtime environment ID'),
        invocation
      )
  }
}

export function wrapMulticaInvocationForExecutionTarget(
  invocation: MulticaProcessInvocation,
  target: RemoteShellTarget
): MulticaProcessInvocation {
  const validated = validateInvocation(invocation)
  const helper = requireRemoteHelper(
    target.helperCommand ?? DEFAULT_HELPER_COMMAND
  )
  const stdin = encodeMulticaHostEnvelope(validated)

  if (target.kind === 'wsl') {
    return {
      command: 'wsl.exe',
      args: [
        '--distribution',
        requireTargetText(target.distribution, 'WSL distribution'),
        ...(validated.cwd ? ['--cd', validated.cwd] : []),
        '--exec',
        helper,
        ...HELPER_ARGS
      ],
      shell: false,
      stdin
    }
  }

  return {
    command: 'ssh',
    args: [
      ...sshPortArgs(target.port),
      ...sshIdentityArgs(target.identityFile),
      '--',
      requireTargetText(target.host, 'SSH host'),
      helper,
      ...HELPER_ARGS
    ],
    shell: false,
    stdin
  }
}

function assertTargetOwnership(
  profile: MulticaConnectionProfile,
  target: MulticaExecutionTarget
): void {
  const targetId = requireTargetText(target.id, 'execution target ID')
  if (targetId !== profile.executionHostId) {
    throw executionHostMismatch()
  }
}

function assertCurrentHostOwnership(
  profile: MulticaConnectionProfile,
  currentHostId: string
): void {
  if (profile.executionHostId !== currentHostId) {
    throw executionHostMismatch()
  }
}

function executionHostMismatch(): MulticaExecutionHostError {
  return new MulticaExecutionHostError(
    'execution-host-mismatch',
    'Multica profile execution host does not match the selected execution target'
  )
}

function resolveCurrentHostId(explicit: string | undefined): string {
  const value = explicit ?? process.env.ORCA_EXECUTION_HOST_ID ?? 'local'
  return requireTargetText(value, 'current execution host ID')
}

function validateInvocation(
  invocation: MulticaProcessInvocation
): MulticaProcessInvocation {
  return decodeMulticaHostEnvelope(encodeMulticaHostEnvelope(invocation))
}

function sshPortArgs(port: number | undefined): string[] {
  if (port === undefined) {
    return []
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new MulticaExecutionHostError(
      'invalid-execution-target',
      'Invalid Multica SSH port'
    )
  }
  return ['-p', String(port)]
}

function sshIdentityArgs(identityFile: string | undefined): string[] {
  return identityFile === undefined
    ? []
    : ['-i', requireTargetText(identityFile, 'SSH identity file')]
}

function requireRemoteHelper(value: string): string {
  const helper = requireTargetText(value, 'host helper command')
  if (!SAFE_REMOTE_HELPER.test(helper)) {
    throw new MulticaExecutionHostError(
      'invalid-execution-target',
      'Invalid Multica host helper command'
    )
  }
  return helper
}

function requireTargetText(value: string, label: string): string {
  const trimmed = value.trim()
  if (
    !trimmed ||
    trimmed.length > TARGET_TEXT_MAX_CHARS ||
    containsControlCharacter(trimmed)
  ) {
    throw new MulticaExecutionHostError(
      'invalid-execution-target',
      `Invalid Multica ${label}`
    )
  }
  return trimmed
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
