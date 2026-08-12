import { describe, expect, it } from 'vitest'
import type { MulticaConnectionProfile } from './multica-types'
import {
  MULTICA_STATE_FILE_MAX_BYTES,
  normalizeMulticaState,
  parseMulticaStateFile,
  upsertMulticaProfile
} from './multica-state'

function createRestProfile(id: string): MulticaConnectionProfile {
  return {
    id,
    displayName: `Profile ${id}`,
    executionHostId: 'local',
    dataPlane: {
      kind: 'rest',
      serverUrl: 'https://api.multica.example',
      credentialRef: `multica:profile:${id}`
    },
    lifecycle: { kind: 'external' },
    managedByOrca: false
  }
}

describe('Multica state', () => {
  it('returns schema version 1 with empty collections for unknown input', () => {
    expect(normalizeMulticaState(null)).toEqual({
      schemaVersion: 1,
      profiles: [],
      repoBindings: [],
      workspaceBindings: [],
      skillReceipts: []
    })
  })

  it('rejects invalid JSON and unsupported schema versions', () => {
    expect(() => parseMulticaStateFile('{')).toThrow('Multica state contains invalid JSON')
    expect(() => parseMulticaStateFile('{"schemaVersion":2}')).toThrow(
      "Unsupported Multica state schema version '2'"
    )
  })

  it('rejects a document larger than the state byte limit', () => {
    expect(() =>
      parseMulticaStateFile('x'.repeat(MULTICA_STATE_FILE_MAX_BYTES + 1))
    ).toThrow('Multica state exceeds')
  })

  it('replaces one profile without changing unrelated profiles', () => {
    const first = createRestProfile('first')
    const second = createRestProfile('second')
    const updated = { ...first, displayName: 'Updated' }
    const populated = upsertMulticaProfile(
      upsertMulticaProfile(normalizeMulticaState(null), first),
      second
    )

    expect(populated.profiles).toEqual([first, second])
    expect(upsertMulticaProfile(populated, updated).profiles).toEqual([second, updated])
  })

  it('normalizes only object entries from persisted collections', () => {
    expect(
      normalizeMulticaState({
        profiles: [createRestProfile('valid'), null, 'invalid'],
        repoBindings: [{ repoId: 'repo', connectionProfileId: 'valid' }, 42],
        workspaceBindings: [false],
        skillReceipts: [{ direction: 'orca-to-multica', sourceId: 'skill' }, []]
      })
    ).toEqual({
      schemaVersion: 1,
      profiles: [createRestProfile('valid')],
      repoBindings: [{ repoId: 'repo', connectionProfileId: 'valid' }],
      workspaceBindings: [],
      skillReceipts: [{ direction: 'orca-to-multica', sourceId: 'skill' }]
    })
  })
})
