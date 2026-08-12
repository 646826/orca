import { describe, expect, it } from 'vitest'
import type { MulticaInstanceLifecycle } from '../../shared/multica/multica-types'
import {
  buildMulticaComposeInvocation,
  type MulticaLifecycleAction
} from './multica-compose-commands'

const NUL = String.fromCharCode(0)

const lifecycle: MulticaInstanceLifecycle = {
  kind: 'docker-compose',
  workingDirectory: '/srv/multica',
  composeFiles: ['compose.yml'],
  environmentFile: '.env',
  projectName: 'team',
  pullBeforeStart: true
}

const expectedArgs: Record<MulticaLifecycleAction, string[]> = {
  config: [
    'compose',
    '-f',
    'compose.yml',
    '--env-file',
    '.env',
    '-p',
    'team',
    'config',
    '--quiet'
  ],
  status: [
    'compose',
    '-f',
    'compose.yml',
    '--env-file',
    '.env',
    '-p',
    'team',
    'ps',
    '--format',
    'json'
  ],
  start: ['compose', '-f', 'compose.yml', '--env-file', '.env', '-p', 'team', 'up', '-d'],
  stop: ['compose', '-f', 'compose.yml', '--env-file', '.env', '-p', 'team', 'stop'],
  restart: ['compose', '-f', 'compose.yml', '--env-file', '.env', '-p', 'team', 'restart'],
  pull: ['compose', '-f', 'compose.yml', '--env-file', '.env', '-p', 'team', 'pull'],
  apply: [
    'compose',
    '-f',
    'compose.yml',
    '--env-file',
    '.env',
    '-p',
    'team',
    'up',
    '-d',
    '--remove-orphans'
  ]
}

describe('buildMulticaComposeInvocation', () => {
  for (const [action, args] of Object.entries(expectedArgs) as [
    MulticaLifecycleAction,
    string[]
  ][]) {
    it(`builds the ${action} command without a shell`, () => {
      expect(buildMulticaComposeInvocation(action, lifecycle)).toEqual({
        command: 'docker',
        args,
        cwd: '/srv/multica',
        shell: false
      })
    })
  }

  it('repeats compose-file flags in order and omits absent optional flags', () => {
    expect(
      buildMulticaComposeInvocation('status', {
        kind: 'docker-compose',
        workingDirectory: '/srv/multica',
        composeFiles: ['compose.yml', 'compose.prod.yml'],
        pullBeforeStart: false
      })
    ).toEqual({
      command: 'docker',
      args: [
        'compose',
        '-f',
        'compose.yml',
        '-f',
        'compose.prod.yml',
        'ps',
        '--format',
        'json'
      ],
      cwd: '/srv/multica',
      shell: false
    })
  })

  it('rejects external lifecycle profiles', () => {
    expect(() => buildMulticaComposeInvocation('start', { kind: 'external' })).toThrow(
      'Multica lifecycle is not managed by Docker Compose'
    )
  })

  it.each([
    ['working directory', { ...lifecycle, workingDirectory: ' ' }],
    ['compose file', { ...lifecycle, composeFiles: [''] }],
    ['environment file', { ...lifecycle, environmentFile: '\n.env' }],
    ['project name', { ...lifecycle, projectName: 'team\nother' }],
    ['NUL byte', { ...lifecycle, workingDirectory: `/srv${NUL}multica` }]
  ])('rejects an unsafe %s', (_name, unsafeLifecycle) => {
    expect(() =>
      buildMulticaComposeInvocation(
        'start',
        unsafeLifecycle as Extract<MulticaInstanceLifecycle, { kind: 'docker-compose' }>
      )
    ).toThrow('Invalid Multica Docker Compose lifecycle value')
  })

  it('rejects missing or excessive compose-file lists', () => {
    expect(() =>
      buildMulticaComposeInvocation('start', { ...lifecycle, composeFiles: [] })
    ).toThrow('Multica Docker Compose lifecycle requires 1 to 8 compose files')
    expect(() =>
      buildMulticaComposeInvocation('start', {
        ...lifecycle,
        composeFiles: Array.from({ length: 9 }, (_, index) => `compose-${index}.yml`)
      })
    ).toThrow('Multica Docker Compose lifecycle requires 1 to 8 compose files')
  })
})
