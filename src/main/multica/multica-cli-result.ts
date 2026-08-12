import type { MulticaProcessResult } from '../../shared/multica/multica-host-envelope'
import { redactMulticaSecrets } from '../../shared/multica/multica-redaction'

export const MULTICA_CLI_OUTPUT_MAX_BYTES = 1024 * 1024

export type MulticaCliResultErrorCode =
  | 'timeout'
  | 'output-limit'
  | 'signal'
  | 'incomplete'
  | 'exit'
  | 'empty-output'
  | 'invalid-json'
  | 'invalid-data'

export class MulticaCliResultError extends Error {
  readonly code: MulticaCliResultErrorCode
  readonly exitCode: number | undefined
  readonly signal: string | undefined

  constructor(
    code: MulticaCliResultErrorCode,
    message: string,
    metadata: { exitCode?: number; signal?: string } = {}
  ) {
    super(message)
    this.name = 'MulticaCliResultError'
    this.code = code
    this.exitCode = metadata.exitCode
    this.signal = metadata.signal
  }
}

export function parseMulticaCliTextResult(result: MulticaProcessResult): string {
  const output = assertSuccessfulResult(result).trim()
  if (!output) {
    throw new MulticaCliResultError('empty-output', 'Multica CLI returned empty output')
  }
  return output
}

export function parseMulticaCliJsonResult<T>(
  result: MulticaProcessResult,
  validate: (value: unknown) => T
): T {
  const output = parseMulticaCliTextResult(result)
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    throw new MulticaCliResultError('invalid-json', 'Multica CLI returned invalid JSON')
  }

  try {
    return validate(value)
  } catch (error) {
    const detail = error instanceof Error ? formatDiagnostic(error.message) : ''
    throw new MulticaCliResultError(
      'invalid-data',
      detail ? `Multica CLI returned invalid data: ${detail}` : 'Multica CLI returned invalid data'
    )
  }
}

function assertSuccessfulResult(result: MulticaProcessResult): string {
  if (result.timedOut) {
    throw new MulticaCliResultError('timeout', 'Multica CLI command timed out')
  }
  if (result.truncated) {
    throw outputLimitError()
  }
  assertOutputSize(result.stdout, result.stderr)

  if (result.signal !== null) {
    const signal = normalizeSignal(result.signal)
    throw new MulticaCliResultError('signal', `Multica CLI terminated by ${signal}`, { signal })
  }
  if (result.exitCode === null) {
    throw new MulticaCliResultError(
      'incomplete',
      'Multica CLI command ended without an exit code or signal'
    )
  }
  if (result.exitCode !== 0) {
    const detail = formatDiagnostic(result.stderr || result.stdout)
    throw new MulticaCliResultError(
      'exit',
      detail
        ? `Multica CLI failed with exit code ${result.exitCode}: ${detail}`
        : `Multica CLI failed with exit code ${result.exitCode}`,
      { exitCode: result.exitCode }
    )
  }
  return result.stdout
}

function assertOutputSize(stdout: string, stderr: string): void {
  const encoder = new TextEncoder()
  const size = encoder.encode(stdout).byteLength + encoder.encode(stderr).byteLength
  if (size > MULTICA_CLI_OUTPUT_MAX_BYTES) {
    throw outputLimitError()
  }
}

function outputLimitError(): MulticaCliResultError {
  return new MulticaCliResultError(
    'output-limit',
    `Multica CLI output exceeded ${MULTICA_CLI_OUTPUT_MAX_BYTES} bytes`
  )
}

function normalizeSignal(signal: string): string {
  return /^[A-Z0-9_+-]{1,64}$/.test(signal) ? signal : 'UNKNOWN_SIGNAL'
}

function formatDiagnostic(value: string): string {
  return redactMulticaSecrets(value).replace(/\s+/g, ' ').trim().slice(0, 1024)
}
