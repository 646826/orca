import { describe, expect, it } from 'vitest'
import type { MulticaProcessInvocation } from '../../shared/multica/multica-host-envelope'
import {
  MulticaProcessSpawnError,
  executeLocalMulticaProcess
} from './multica-process-executor'

function nodeInvocation(
  script: string,
  options: {
    args?: string[]
    env?: Record<string, string>
    stdin?: string
  } = {}
): MulticaProcessInvocation {
  return {
    command: process.execPath,
    args: ['-e', script, ...(options.args ?? [])],
    shell: false,
    ...(options.env ? { env: options.env } : {}),
    ...(options.stdin === undefined ? {} : { stdin: options.stdin })
  }
}

describe('executeLocalMulticaProcess', () => {
  it('captures stdout, stderr, exit code, and signal', async () => {
    const result = await executeLocalMulticaProcess(
      nodeInvocation("process.stdout.write('out'); process.stderr.write('err')")
    )

    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      stdout: 'out',
      stderr: 'err',
      timedOut: false,
      truncated: false
    })
  })

  it('passes stdin and the allowlisted invocation environment without shell interpolation', async () => {
    const literal = '$(echo should-not-run); & exit 9'
    const script = [
      "let input = ''",
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', (chunk) => { input += chunk })",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({",
      '    input,',
      '    token: process.env.MULTICA_TOKEN,',
      '    literal: process.argv[1],',
      "    leaked: process.env.ORCA_MULTICA_UNSAFE ?? null",
      '  }))',
      '})'
    ].join(';')

    const result = await executeLocalMulticaProcess(
      nodeInvocation(script, {
        args: [literal],
        env: { MULTICA_TOKEN: 'mul_test_token_12345678' },
        stdin: 'hello from stdin'
      }),
      {
        baseEnvironment: {
          PATH: process.env.PATH,
          ORCA_MULTICA_UNSAFE: 'must-not-be-inherited'
        },
        inheritedEnvironmentKeys: ['PATH']
      }
    )

    expect(JSON.parse(result.stdout)).toEqual({
      input: 'hello from stdin',
      token: 'mul_test_token_12345678',
      literal,
      leaked: null
    })
  })

  it('marks a timed-out command and terminates it', async () => {
    const startedAt = Date.now()
    const result = await executeLocalMulticaProcess(
      nodeInvocation("process.stdout.write('started'); setTimeout(() => {}, 10_000)"),
      { timeoutMs: 100 }
    )

    expect(result.timedOut).toBe(true)
    expect(result.truncated).toBe(false)
    expect(result.stdout).toBe('started')
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it.skipIf(process.platform === 'win32')(
    'force-kills a command that ignores graceful termination',
    async () => {
      const startedAt = Date.now()
      const result = await executeLocalMulticaProcess(
        nodeInvocation(
          "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 10_000)"
        ),
        { timeoutMs: 100 }
      )

      expect(result.timedOut).toBe(true)
      expect(result.signal).toBe('SIGKILL')
      expect(result.stdout).toBe('ready')
      expect(Date.now() - startedAt).toBeLessThan(5_000)
    }
  )

  it('enforces one combined byte limit across stdout and stderr', async () => {
    const result = await executeLocalMulticaProcess(
      nodeInvocation(
        "process.stdout.write('a'.repeat(700)); process.stderr.write('b'.repeat(700)); setTimeout(() => {}, 10_000)"
      ),
      { maxOutputBytes: 1_024, timeoutMs: 5_000 }
    )

    expect(result.truncated).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      1_024
    )
  })

  it('retains complete UTF-8 output when it fits inside the limit', async () => {
    const result = await executeLocalMulticaProcess(
      nodeInvocation("process.stdout.write('Привет 🌍')"),
      { maxOutputBytes: 128 }
    )

    expect(result.stdout).toBe('Привет 🌍')
    expect(result.truncated).toBe(false)
  })

  it('rejects shell-enabled invocations at runtime', async () => {
    await expect(
      executeLocalMulticaProcess({
        command: process.execPath,
        args: ['--version'],
        shell: true
      } as unknown as MulticaProcessInvocation)
    ).rejects.toThrow('shell=false')
  })

  it.each([
    ['timeout', { timeoutMs: 0 }],
    ['output limit', { maxOutputBytes: 0 }],
    ['environment key', { inheritedEnvironmentKeys: ['BAD=KEY'] }],
    ['protected environment key', { inheritedEnvironmentKeys: ['MULTICA_TOKEN'] }]
  ])('rejects an invalid %s option', async (_name, options) => {
    await expect(
      executeLocalMulticaProcess(nodeInvocation("process.stdout.write('ok')"), options)
    ).rejects.toThrow()
  })

  it('rejects spawn failures with a typed, redacted error', async () => {
    const token = 'mul_spawn_secret_12345678'
    let captured: unknown
    try {
      await executeLocalMulticaProcess(
        {
          command: `/definitely/missing/${token}`,
          args: [],
          shell: false
        },
        { baseEnvironment: {}, inheritedEnvironmentKeys: [] }
      )
    } catch (error) {
      captured = error
    }

    expect(captured).toBeInstanceOf(MulticaProcessSpawnError)
    expect((captured as Error).message).not.toContain(token)
    expect((captured as MulticaProcessSpawnError).code).toBeTruthy()
  })
})
