import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquireProfileStateRuntimeAdmission,
  withProfileStateRuntimeMigration
} from './profile-state-access'
import { profileStateAccessPaths, publishAccessOwner } from './profile-state-access-owner'

const roots: string[] = []
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'orca-runtime-migration-'))
  roots.push(path)
  return path
}

afterEach(() => {
  for (const path of roots.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('runtime schema migration admission', () => {
  it('requires an actual live runtime admission for the exact root', () => {
    const path = root()
    const run = vi.fn()
    expect(() => withProfileStateRuntimeMigration(path, run)).toThrow(/admission/i)
    const admission = acquireProfileStateRuntimeAdmission(path)
    try {
      expect(() => withProfileStateRuntimeMigration(root(), run)).toThrow(/admission/i)
    } finally {
      admission.release()
    }
    expect(() => withProfileStateRuntimeMigration(path, run)).toThrow(/admission/i)
    expect(run).not.toHaveBeenCalled()
  })

  it('blocks new runtime admission while migrating and releases maintenance on failure', () => {
    const path = root()
    const admission = acquireProfileStateRuntimeAdmission(path)
    try {
      expect(() =>
        withProfileStateRuntimeMigration(path, () => {
          expect(() => acquireProfileStateRuntimeAdmission(path)).toThrow(/in use/i)
          throw new Error('migration failed')
        })
      ).toThrow('migration failed')
      const next = acquireProfileStateRuntimeAdmission(path)
      next.release()
      expect(withProfileStateRuntimeMigration(path, () => 42)).toBe(42)
    } finally {
      admission.release()
    }
  })

  it('does not exempt another admission from the same process', () => {
    const path = root()
    const first = acquireProfileStateRuntimeAdmission(path)
    const second = acquireProfileStateRuntimeAdmission(path)
    const run = vi.fn()
    try {
      expect(() => withProfileStateRuntimeMigration(path, run)).toThrow(/admission/i)
      expect(run).not.toHaveBeenCalled()
    } finally {
      second.release()
      first.release()
    }
  })

  it('refuses an unverifiable participant without entering migration', () => {
    const path = root()
    const admission = acquireProfileStateRuntimeAdmission(path)
    const participant = join(profileStateAccessPaths(path).participants, 'unverifiable')
    mkdirSync(participant)
    writeFileSync(join(participant, 'bad.owner'), '{}')
    const run = vi.fn()
    try {
      expect(() => withProfileStateRuntimeMigration(path, run)).toThrow(/unverifiable/i)
      expect(run).not.toHaveBeenCalled()
    } finally {
      admission.release()
    }
  })

  it('refuses another live owner not registered by this runtime', () => {
    const path = root()
    const admission = acquireProfileStateRuntimeAdmission(path)
    const other = publishAccessOwner(profileStateAccessPaths(path), false)
    const run = vi.fn()
    try {
      expect(() => withProfileStateRuntimeMigration(path, run)).toThrow(/in use/i)
      expect(run).not.toHaveBeenCalled()
      other.release()
      withProfileStateRuntimeMigration(path, run)
      expect(run).toHaveBeenCalledOnce()
    } finally {
      other.release()
      admission.release()
    }
  })

  it('an old repeated release cannot unregister a newer admission', () => {
    const path = root()
    const old = acquireProfileStateRuntimeAdmission(path)
    old.release()
    const current = acquireProfileStateRuntimeAdmission(path)
    try {
      old.release()
      expect(withProfileStateRuntimeMigration(path, () => 42)).toBe(42)
    } finally {
      current.release()
    }
  })
})
