import { describe, expect, it } from 'vitest'
import type { MulticaProcessResult } from '../../shared/multica/multica-host-envelope'
import {
  MULTICA_CLI_OUTPUT_MAX_BYTES,
  MulticaCliResultError,
  parseMulticaCliJsonResult,
  parseMulticaCliTextResult
} from './multica-cli-result'

function processResult(overrides: Partial<MulticaProcessResult> = {}): MulticaProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    truncated: false,
    ...overrides
  }
}

function captureError(run: () => unknown): MulticaCliResultError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(MulticaCliResultError)
    return error as MulticaCliResultError
  }
  throw new Error('Expected MulticaCliResultError')
}

describe('Multica CLI result parsing', () => {
  it('parses and trims successful text output', () => {
    expect(parseMulticaCliTextResult(processResult({ stdout: '  v0.5.1\r\n' }))).toBe('v0.5.1')
  })

  it('parses successful JSON through a caller-supplied validator', () => {
    const parsed = parseMulticaCliJsonResult(
      processResult({ stdout: '{"id":"workspace-1","name":"Engineering"}\n' }),
      (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('workspace must be an object')
        }
        const record = value as Record<string, unknown>
        if (typeof record.id !== 'string' || typeof record.name !== 'string') {
          throw new Error('workspace fields are invalid')
        }
        return { id: record.id, name: record.name }
      }
    )

    expect(parsed).toEqual({ id: 'workspace-1', name: 'Engineering' })
  })

  it('rejects timed-out commands before reading their output', () => {
    const error = captureError(() =>
      parseMulticaCliTextResult(
        processResult({ timedOut: true, stdout: 'mul_super_secret_token' })
      )
    )

    expect(error.code).toBe('timeout')
    expect(error.message).not.toContain('mul_super_secret_token')
  })

  it('rejects results marked as truncated', () => {
    const error = captureError(() =>
      parseMulticaCliJsonResult(processResult({ truncated: true, stdout: '{}' }), (value) => value)
    )

    expect(error.code).toBe('output-limit')
  })

  it('rejects results exceeding the byte limit even when the host flag is wrong', () => {
    const error = captureError(() =>
      parseMulticaCliTextResult(
        processResult({ stdout: 'x'.repeat(MULTICA_CLI_OUTPUT_MAX_BYTES + 1) })
      )
    )

    expect(error.code).toBe('output-limit')
  })

  it('classifies signal termination and incomplete host results', () => {
    const signalled = captureError(() =>
      parseMulticaCliTextResult(processResult({ exitCode: null, signal: 'SIGTERM' }))
    )
    const incomplete = captureError(() =>
      parseMulticaCliTextResult(processResult({ exitCode: null, signal: null }))
    )

    expect(signalled.code).toBe('signal')
    expect(signalled.signal).toBe('SIGTERM')
    expect(incomplete.code).toBe('incomplete')
  })

  it('reports a non-zero exit with bounded redacted diagnostics', () => {
    const error = captureError(() =>
      parseMulticaCliTextResult(
        processResult({
          exitCode: 7,
          stderr:
            'Authorization: Bearer mul_super_secret_token permission denied token="mat_agent_secret_value"'
        })
      )
    )

    expect(error.code).toBe('exit')
    expect(error.exitCode).toBe(7)
    expect(error.message).toContain('permission denied')
    expect(error.message).not.toContain('mul_super_secret_token')
    expect(error.message).not.toContain('mat_agent_secret_value')
    expect(error.message).toContain('[REDACTED]')
  })

  it('rejects empty output', () => {
    const error = captureError(() => parseMulticaCliTextResult(processResult({ stdout: ' \n' })))

    expect(error.code).toBe('empty-output')
  })

  it('rejects malformed JSON without echoing the payload', () => {
    const error = captureError(() =>
      parseMulticaCliJsonResult(
        processResult({ stdout: '{"token":"mul_super_secret_token"' }),
        (value) => value
      )
    )

    expect(error.code).toBe('invalid-json')
    expect(error.message).not.toContain('mul_super_secret_token')
    expect(error.message).not.toContain('{"token"')
  })

  it('wraps validator failures with redacted diagnostics', () => {
    const error = captureError(() =>
      parseMulticaCliJsonResult(processResult({ stdout: '{}' }), () => {
        throw new Error('invalid workspace for mul_super_secret_token')
      })
    )

    expect(error.code).toBe('invalid-data')
    expect(error.message).toContain('invalid workspace')
    expect(error.message).not.toContain('mul_super_secret_token')
  })
})
