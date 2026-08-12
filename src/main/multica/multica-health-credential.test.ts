import { describe, expect, it } from 'vitest'
import type { MulticaConnectionProfile } from '../../shared/multica/multica-types'
import {
  probeMulticaHealth,
  type MulticaHealthReadJson
} from './multica-health'
import { MulticaReadTransportError } from './multica-read-transport'

function profile(kind: 'rest' | 'cli'): MulticaConnectionProfile {
  return {
    id: `${kind}-profile`,
    displayName: `${kind} profile`,
    executionHostId: 'local',
    dataPlane:
      kind === 'rest'
        ? {
            kind: 'rest',
            serverUrl: 'https://multica.example',
            credentialRef: 'credential/rest'
          }
        : {
            kind: 'cli',
            executable: 'multica',
            credentialRef: 'credential/cli'
          },
    lifecycle: { kind: 'external' },
    managedByOrca: false
  }
}

describe('Multica health credential failures', () => {
  it.each(['rest', 'cli'] as const)(
    'maps a %s credential resolver failure to authentication-failed',
    async (kind) => {
      const secret = 'mul_abcdefghijklmnopqrstuvwxyz0123456789'
      const readJson: MulticaHealthReadJson = async <T>(): Promise<T> => {
        throw new MulticaReadTransportError(
          'credential',
          `Unable to resolve credential containing ${secret}`
        )
      }

      const state = await probeMulticaHealth(profile(kind), { readJson })

      expect(state).toEqual({
        kind: 'authentication-failed',
        message: 'Multica authentication failed'
      })
      expect(JSON.stringify(state)).not.toContain(secret)
    }
  )
})
