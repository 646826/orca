import type {
  LificCommandRunner,
  ProcessInvocation,
  ProcessResult
} from '../../shared/lific/lific-types'
import { encodeHostExecutionEnvelope } from '../../shared/lific/lific-host-envelope'

export type LificExecutionHost =
  | { kind: 'local'; id: string }
  | { kind: 'wsl'; id: string; distribution: string; helperCommand?: string; helperArgs?: string[] }
  | {
      kind: 'ssh'
      id: string
      host: string
      port?: number
      identityFile?: string
      helperCommand?: string
      helperArgs?: string[]
    }
  | { kind: 'runtime'; id: string; runtimeEnvironmentId: string }

const DEFAULT_HELPER = 'orca-lific-host-exec'

/**
 * Convert a local process description into a host-specific transport without
 * ever interpolating user input into a shell command. Secrets travel inside a
 * base64 JSON envelope over stdin, not in SSH/WSL argv or logs.
 */
export function wrapInvocationForExecutionHost(
  invocation: ProcessInvocation,
  host: Exclude<LificExecutionHost, { kind: 'runtime' }>
): ProcessInvocation {
  if (host.kind === 'local') {
    return invocation
  }
  const helper = host.helperCommand ?? DEFAULT_HELPER
  const helperArgs = host.helperArgs ?? ['--envelope-stdin']
  const stdin = encodeHostExecutionEnvelope(invocation)
  if (host.kind === 'wsl') {
    return {
      command: 'wsl.exe',
      args: [
        '--distribution',
        host.distribution,
        ...(invocation.cwd ? ['--cd', invocation.cwd] : []),
        '--exec',
        helper,
        ...helperArgs
      ],
      shell: false,
      stdin
    }
  }
  return {
    command: 'ssh',
    args: [
      ...(host.port ? ['-p', String(host.port)] : []),
      ...(host.identityFile ? ['-i', host.identityFile] : []),
      '--',
      host.host,
      helper,
      ...helperArgs
    ],
    shell: false,
    stdin
  }
}

export function createExecutionHostRunner(input: {
  host: LificExecutionHost
  localRunner: LificCommandRunner
  runtimeExecutor?: (
    runtimeEnvironmentId: string,
    invocation: ProcessInvocation
  ) => Promise<ProcessResult>
}): LificCommandRunner {
  return {
    async run(invocation): Promise<ProcessResult> {
      if (input.host.kind === 'runtime') {
        if (!input.runtimeExecutor) {
          return {
            exitCode: null,
            stdout: '',
            stderr: 'No runtime executor is configured for this execution host',
            errorCode: 'RUNTIME_EXECUTOR_UNAVAILABLE'
          }
        }
        return input.runtimeExecutor(input.host.runtimeEnvironmentId, invocation)
      }
      return input.localRunner.run(wrapInvocationForExecutionHost(invocation, input.host))
    }
  }
}
