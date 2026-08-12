import type { MulticaInstanceLifecycle } from '../../shared/multica/multica-types'

export type MulticaLifecycleAction =
  | 'config'
  | 'status'
  | 'start'
  | 'stop'
  | 'restart'
  | 'pull'
  | 'apply'

export type MulticaComposeInvocation = {
  command: 'docker'
  args: string[]
  cwd: string
  shell: false
}

type ManagedLifecycle = Extract<MulticaInstanceLifecycle, { kind: 'docker-compose' }>

const ACTION_ARGS: Record<MulticaLifecycleAction, readonly string[]> = {
  config: ['config', '--quiet'],
  status: ['ps', '--format', 'json'],
  start: ['up', '-d'],
  stop: ['stop'],
  restart: ['restart'],
  pull: ['pull'],
  apply: ['up', '-d', '--remove-orphans']
}

export function buildMulticaComposeInvocation(
  action: MulticaLifecycleAction,
  lifecycle: MulticaInstanceLifecycle
): MulticaComposeInvocation {
  if (lifecycle.kind !== 'docker-compose') {
    throw new Error('Multica lifecycle is not managed by Docker Compose')
  }
  validateLifecycle(lifecycle)

  const args = ['compose']
  for (const file of lifecycle.composeFiles) {
    args.push('-f', file)
  }
  if (lifecycle.environmentFile) {
    args.push('--env-file', lifecycle.environmentFile)
  }
  if (lifecycle.projectName) {
    args.push('-p', lifecycle.projectName)
  }
  args.push(...ACTION_ARGS[action])

  return {
    command: 'docker',
    args,
    cwd: lifecycle.workingDirectory,
    shell: false
  }
}

function validateLifecycle(lifecycle: ManagedLifecycle): void {
  if (lifecycle.composeFiles.length < 1 || lifecycle.composeFiles.length > 8) {
    throw new Error('Multica Docker Compose lifecycle requires 1 to 8 compose files')
  }
  const values = [
    lifecycle.workingDirectory,
    ...lifecycle.composeFiles,
    lifecycle.environmentFile,
    lifecycle.projectName
  ]
  for (const value of values) {
    if (value === undefined) {
      continue
    }
    if (!value.trim() || /[\r\n\0]/.test(value)) {
      throw new Error('Invalid Multica Docker Compose lifecycle value')
    }
  }
}
