import { describe, expect, it } from 'vitest'
import type { MulticaProcessInvocation } from '../../shared/multica/multica-host-envelope'
import type { MulticaConnectionProfile } from '../../shared/multica/multica-types'
import {
  MulticaExecutionHostError,
  runMulticaOnExecutionHost
} from './multica-execution-host'

const invocation: MulticaProcessInvocation = {
  command: 'multica',
  args: ['version', '--output', 'json'],
  shell: false
}

const profile: MulticaConnectionProfile = {
  id: 'ssh-profile',
  displayName: 'SSH profile',
  executionHostId: 'ssh:production',
  executionTarget: {
    kind: 'ssh',
    id: 'ssh:production',
    connectionId: 'connection-1',
    host: 'deploy@multica.example',
    helperCommand: 'orca-ide; touch /tmp/multica-injected'
  },
  dataPlane: {
    kind: 'cli',
    executable: 'multica'
  },
  lifecycle: { kind: 'external' },
  managedByOrca: false
}

describe('Multica SSH host helper validation', () => {
  it('rejects shell metacharacters before invoking ssh', async () => {
    let executed = false

    let captured: unknown
    try {
      await runMulticaOnExecutionHost({
        profile,
        invocation,
        executeLocal: async () => {
          executed = true
          throw new Error('executor must not run')
        }
      })
    } catch (error) {
      captured = error
    }

    expect(captured).toBeInstanceOf(MulticaExecutionHostError)
    expect((captured as MulticaExecutionHostError).code).toBe(
      'invalid-execution-target'
    )
    expect(executed).toBe(false)
  })
})
