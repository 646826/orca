import { spawnSync } from 'node:child_process'
import { redactLificSecrets } from '../../shared/lific/lific-redaction'
import type { ProcessInvocation, ProcessResult } from '../../shared/lific/lific-types'

const HOST_COMMAND_TIMEOUT_MS = 120_000
const HOST_COMMAND_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024

/** Execute one validated host envelope without importing Electron main-process code. */
export function runLificHostCommand(invocation: ProcessInvocation): ProcessResult {
  if (invocation.shell !== false) {
    throw new Error('Lific commands must run with shell=false')
  }

  const result = spawnSync(invocation.command, invocation.args, {
    shell: false,
    cwd: invocation.cwd,
    env: { ...process.env, ...invocation.env },
    input: invocation.stdin,
    encoding: 'utf8',
    windowsHide: true,
    timeout: HOST_COMMAND_TIMEOUT_MS,
    maxBuffer: HOST_COMMAND_OUTPUT_LIMIT_BYTES
  })
  const error = result.error as NodeJS.ErrnoException | undefined
  const stderr = [result.stderr, error?.message].filter(Boolean).join('\n')

  return {
    exitCode: result.status,
    stdout: redactLificSecrets(result.stdout ?? ''),
    stderr: redactLificSecrets(stderr),
    ...(error?.code ? { errorCode: error.code } : {})
  }
}
