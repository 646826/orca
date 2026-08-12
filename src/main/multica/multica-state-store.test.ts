import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MULTICA_STATE_FILE_MAX_BYTES, normalizeMulticaState } from '../../shared/multica/multica-state'
import type { MulticaConnectionProfile } from '../../shared/multica/multica-types'
import { MulticaStateStore, resolveMulticaDataDirectory } from './multica-state-store'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-multica-state-'))
  roots.push(root)
  return root
}

function profile(id: string): MulticaConnectionProfile {
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

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  vi.unstubAllEnvs()
})

describe('MulticaStateStore', () => {
  it('resolves explicit, Orca-data, and home-scoped directories in order', () => {
    vi.stubEnv('ORCA_MULTICA_DATA_DIR', '/explicit/multica')
    vi.stubEnv('ORCA_DATA_DIR', '/orca-data')
    expect(resolveMulticaDataDirectory('/home/tester')).toBe('/explicit/multica')

    vi.stubEnv('ORCA_MULTICA_DATA_DIR', '')
    expect(resolveMulticaDataDirectory('/home/tester')).toBe(join('/orca-data', 'multica'))

    vi.stubEnv('ORCA_DATA_DIR', '')
    expect(resolveMulticaDataDirectory('/home/tester')).toBe(join('/home/tester', '.orca', 'multica'))
  })

  it('returns empty state when the file does not exist and persists profiles', async () => {
    const root = tempRoot()
    const store = new MulticaStateStore(root)

    expect(store.read()).toEqual(normalizeMulticaState(null))
    await store.putProfile(profile('production'))

    expect(store.read().profiles).toEqual([profile('production')])
    expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      profiles: [{ id: 'production' }]
    })
  })

  it('serializes concurrent read-modify-write mutations without losing profiles', async () => {
    const store = new MulticaStateStore(tempRoot())

    await Promise.all([
      store.putProfile(profile('first')),
      store.putProfile(profile('second')),
      store.putProfile(profile('third'))
    ])

    expect(store.read().profiles.map((entry) => entry.id)).toEqual(['first', 'second', 'third'])
  })

  it('rejects a serialized document larger than the state limit', async () => {
    const store = new MulticaStateStore(tempRoot())
    const oversized = normalizeMulticaState(null)
    oversized.profiles = [
      { ...profile('oversized'), displayName: 'x'.repeat(MULTICA_STATE_FILE_MAX_BYTES) }
    ]

    await expect(store.write(oversized)).rejects.toThrow('Multica state exceeds')
  })
})
