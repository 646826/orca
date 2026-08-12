import { describe, expect, it } from 'vitest'
import type {
  MulticaProcessInvocation,
  MulticaProcessResult
} from '../../shared/multica/multica-host-envelope'
import {
  MULTICA_COMMAND_OUTPUT_MAX_BYTES,
  MULTICA_COMMAND_TIMEOUT_MS,
  MulticaCommandRunner,
  type MulticaProcessExecution
} from './multica-command-runner'

const invocation: MulticaProcessInvocation = {
  command: 'multica',
  args: ['version', '--output', 'json'],
  shell: false,
  env: { MULTICA_TOKEN: 'mul_runner_secret' }
}

function result(): MulticaProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: '{"version":"1.0.0"}',
    stderr: '',
    timedOut: false,
    truncated: false
  }
}

describe('MulticaCommandRunner', () => {
  it('uses the foundation 60-second timeout and 10 MiB combined output cap', async () => {
    const calls: Parameters<MulticaProcessExecution>[] = []
    const execute: MulticaProcessExecution = async (...args) => {
      calls.push(args)
      return result()
    }
    const runner = new MulticaCommandRunner({ execute })

    await expect(runner.run(invocation)).resolves.toEqual(result())

    expect(calls).toEqual([
      [
        invocation,
        {
          timeoutMs: 60_000,
          maxOutputBytes: 10 * 1024 * 1024
        }
      ]
    ])
    expect(MULTICA_COMMAND_TIMEOUT_MS).toBe(60_000)
    expect(MULTICA_COMMAND_OUTPUT_MAX_BYTES).toBe(10 * 1024 * 1024)
  })

  it('forwards explicit bounded executor options without widening credential inheritance', async () => {
    const calls: Parameters<MulticaProcessExecution>[] = []
    const execute: MulticaProcessExecution = async (...args) => {
      calls.push(args)
      return result()
    }
    const baseEnvironment = {
      PATH: '/usr/bin',
      ORCA_MULTICA_UNSAFE: 'not inherited unless explicitly selected'
    }
    const runner = new MulticaCommandRunner({
      execute,
      timeoutMs: 5_000,
      maxOutputBytes: 2_048,
      baseEnvironment,
      inheritedEnvironmentKeys: ['PATH']
    })

    await runner.run(invocation)

    expect(calls).toEqual([
      [
        invocation,
        {
          timeoutMs: 5_000,
          maxOutputBytes: 2_048,
          baseEnvironment,
          inheritedEnvironmentKeys: ['PATH']
        }
      ]
    ])
  })

  it('keeps run bound when passed directly to execution-host dispatch', async () => {
    const execute: MulticaProcessExecution = async () => result()
    const runner = new MulticaCommandRunner({ execute })
    const detached = runner.run

    await expect(detached(invocation)).resolves.toEqual(result())
  })

  it('uses the hardened local process executor by default', async () => {
    const runner = new MulticaCommandRunner({
      baseEnvironment: {},
      inheritedEnvironmentKeys: []
    })

    await expect(
      runner.run({
        command: process.execPath,
        args: ['-e', "process.stdout.write('runner-ok')"],
        shell: false
      })
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'runner-ok',
      stderr: '',
      timedOut: false,
      truncated: false
    })
  })

  it('fails closed on invalid execution limits before spawning', async () => {
    const runner = new MulticaCommandRunner({ timeoutMs: 0 })

    await expect(runner.run(invocation)).rejects.toThrow(
      'Invalid Multica process timeout'
    )
  })
})
