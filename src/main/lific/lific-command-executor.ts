import { spawn } from 'node:child_process'
import type {
  LificCommandRunner,
  ProcessInvocation,
  ProcessResult
} from '../../shared/lific/lific-types'
import { redactLificSecrets } from '../../shared/lific/lific-redaction'

const DEFAULT_TIMEOUT_MS = 120_000
const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8')
  if (Buffer.byteLength(next, 'utf8') <= OUTPUT_LIMIT_BYTES) {
    return next
  }
  return `${next.slice(0, OUTPUT_LIMIT_BYTES)}\n[output truncated]`
}

export class NodeLificCommandRunner implements LificCommandRunner {
  readonly #timeoutMs: number

  constructor(timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.#timeoutMs = timeoutMs
  }

  run(invocation: ProcessInvocation): Promise<ProcessResult> {
    if (invocation.shell !== false) {
      throw new Error('Lific commands must run with shell=false')
    }
    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      let timer: NodeJS.Timeout
      const child = spawn(invocation.command, invocation.args, {
        shell: false,
        cwd: invocation.cwd,
        env: { ...process.env, ...invocation.env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      const finish = (result: ProcessResult): void => {
        if (settled) {
          return
        }
        settled = true
        if (timer) {
          clearTimeout(timer)
        }
        resolve({
          ...result,
          stdout: redactLificSecrets(result.stdout),
          stderr: redactLificSecrets(result.stderr)
        })
      }
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = appendBounded(stdout, chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = appendBounded(stderr, chunk)
      })
      child.on('error', (error: NodeJS.ErrnoException) => {
        finish({
          exitCode: null,
          stdout,
          stderr: error.message,
          ...(error.code ? { errorCode: error.code } : {})
        })
      })
      child.on('close', (exitCode: number | null) => finish({ exitCode, stdout, stderr }))
      if (invocation.stdin !== undefined) {
        child.stdin.end(invocation.stdin)
      } else {
        child.stdin.end()
      }
      timer = setTimeout(() => {
        child.kill('SIGTERM')
        finish({
          exitCode: null,
          stdout,
          stderr: 'Lific command timed out',
          errorCode: 'ETIMEDOUT'
        })
      }, this.#timeoutMs)
    })
  }
}
