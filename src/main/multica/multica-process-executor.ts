import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  decodeMulticaHostEnvelope,
  encodeMulticaHostEnvelope,
  MULTICA_PROCESS_ENV_KEYS,
  type MulticaProcessInvocation,
  type MulticaProcessResult
} from '../../shared/multica/multica-host-envelope'
import { redactMulticaSecrets } from '../../shared/multica/multica-redaction'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_TIMEOUT_MS = 30 * 60 * 1000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const TERMINATION_GRACE_MS = 1_000
const MAX_INHERITED_ENVIRONMENT_KEYS = 128
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const PROTECTED_MULTICA_ENVIRONMENT_KEYS = new Set<string>(MULTICA_PROCESS_ENV_KEYS)

const DEFAULT_INHERITED_ENVIRONMENT_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'TMP',
  'TEMP',
  'TMPDIR',
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'SSH_AUTH_SOCK'
] as const

export type MulticaProcessExecutionOptions = {
  timeoutMs?: number
  maxOutputBytes?: number
  baseEnvironment?: NodeJS.ProcessEnv
  inheritedEnvironmentKeys?: readonly string[]
}

export class MulticaProcessSpawnError extends Error {
  readonly code: string | undefined

  constructor(error: NodeJS.ErrnoException) {
    const detail = redactMulticaSecrets(error.message).replace(/\s+/g, ' ').trim().slice(0, 1024)
    super(detail ? `Unable to start Multica process: ${detail}` : 'Unable to start Multica process')
    this.name = 'MulticaProcessSpawnError'
    this.code = error.code
  }
}

export async function executeLocalMulticaProcess(
  unsafeInvocation: MulticaProcessInvocation,
  options: MulticaProcessExecutionOptions = {}
): Promise<MulticaProcessResult> {
  const invocation = validateInvocation(unsafeInvocation)
  const timeoutMs = requirePositiveInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    'timeout',
    MAX_TIMEOUT_MS
  )
  const maxOutputBytes = requirePositiveInteger(
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    'output limit',
    MAX_OUTPUT_BYTES
  )
  const environment = buildEnvironment(options, invocation.env)

  return await new Promise<MulticaProcessResult>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(invocation.command, invocation.args, {
        shell: false,
        cwd: invocation.cwd,
        env: environment,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      reject(toSpawnError(error))
      return
    }

    const output = createBoundedOutput(maxOutputBytes, () => {
      requestTermination(child)
    })
    let settled = false
    let timedOut = false
    let timeout: NodeJS.Timeout | undefined
    let forceKill: NodeJS.Timeout | undefined

    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout)
      }
      if (forceKill) {
        clearTimeout(forceKill)
      }
    }
    const terminate = (): void => {
      requestTermination(child)
      if (!forceKill) {
        forceKill = setTimeout(() => requestTermination(child, 'SIGKILL'), TERMINATION_GRACE_MS)
        forceKill.unref()
      }
    }
    const rejectOnce = (error: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(toSpawnError(error))
    }

    child.stdout.on('data', (chunk: Buffer) => output.appendStdout(chunk))
    child.stderr.on('data', (chunk: Buffer) => output.appendStderr(chunk))
    child.stdin.on('error', () => undefined)
    child.on('error', rejectOnce)
    child.on('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve({
        exitCode,
        signal,
        ...output.read(),
        timedOut,
        truncated: output.truncated()
      })
    })

    if (invocation.stdin === undefined) {
      child.stdin.end()
    } else {
      child.stdin.end(invocation.stdin)
    }

    timeout = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    timeout.unref()
  })
}

function validateInvocation(invocation: MulticaProcessInvocation): MulticaProcessInvocation {
  return decodeMulticaHostEnvelope(encodeMulticaHostEnvelope(invocation))
}

function buildEnvironment(
  options: MulticaProcessExecutionOptions,
  invocationEnvironment: Record<string, string> | undefined
): NodeJS.ProcessEnv {
  const source = options.baseEnvironment ?? process.env
  const keys = validateInheritedEnvironmentKeys(
    options.inheritedEnvironmentKeys ?? DEFAULT_INHERITED_ENVIRONMENT_KEYS
  )
  const environment: NodeJS.ProcessEnv = {}
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined) {
      environment[key] = value
    }
  }
  for (const [key, value] of Object.entries(invocationEnvironment ?? {})) {
    environment[key] = value
  }
  return environment
}

function validateInheritedEnvironmentKeys(keys: readonly string[]): readonly string[] {
  if (keys.length > MAX_INHERITED_ENVIRONMENT_KEYS) {
    throw new Error(
      `Multica process may inherit at most ${MAX_INHERITED_ENVIRONMENT_KEYS} environment keys`
    )
  }
  const unique = new Set<string>()
  for (const key of keys) {
    if (!ENVIRONMENT_KEY_PATTERN.test(key) || unique.has(key)) {
      throw new Error(`Invalid inherited environment key '${key}'`)
    }
    if (PROTECTED_MULTICA_ENVIRONMENT_KEYS.has(key) || key.startsWith('MULTICA_')) {
      throw new Error(`Multica credential environment key '${key}' must be supplied explicitly`)
    }
    unique.add(key)
  }
  return [...unique]
}

function requirePositiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Invalid Multica process ${label}`)
  }
  return value
}

function requestTermination(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals = 'SIGTERM'
): void {
  if (child.exitCode !== null || child.signalCode !== null || child.killed) {
    return
  }
  try {
    child.kill(signal)
  } catch {
    // The process may have exited between the state check and kill request.
  }
}

function toSpawnError(error: unknown): MulticaProcessSpawnError {
  if (error instanceof MulticaProcessSpawnError) {
    return error
  }
  if (error instanceof Error) {
    return new MulticaProcessSpawnError(error as NodeJS.ErrnoException)
  }
  return new MulticaProcessSpawnError(new Error('Unknown process spawn failure'))
}

function createBoundedOutput(limit: number, onLimit: () => void): {
  appendStdout(chunk: Buffer): void
  appendStderr(chunk: Buffer): void
  truncated(): boolean
  read(): { stdout: string; stderr: string }
} {
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let totalBytes = 0
  let wasTruncated = false

  const append = (target: Buffer[], chunk: Buffer): void => {
    if (wasTruncated || chunk.length === 0) {
      return
    }
    const remaining = limit - totalBytes
    if (remaining <= 0) {
      wasTruncated = true
      onLimit()
      return
    }
    const retained = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
    target.push(Buffer.from(retained))
    totalBytes += retained.length
    if (retained.length < chunk.length) {
      wasTruncated = true
      onLimit()
    }
  }

  return {
    appendStdout: (chunk) => append(stdout, chunk),
    appendStderr: (chunk) => append(stderr, chunk),
    truncated: () => wasTruncated,
    read: () => ({
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8')
    })
  }
}
