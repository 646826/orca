import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`, 'utf8')),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8').replace(/^encrypted:/, ''))
}))

vi.mock('electron', () => ({ safeStorage: safeStorageMock }))

import { OrcaMulticaSecretStore } from './multica-secret-store'

const roots: string[] = []
const MASTER_KEY = 'multica-test-master-key-with-at-least-32-characters'

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-multica-secrets-'))
  roots.push(root)
  return root
}

beforeEach(() => {
  vi.unstubAllEnvs()
  vi.stubEnv('ORCA_MULTICA_MASTER_KEY', MASTER_KEY)
  safeStorageMock.isEncryptionAvailable.mockReset()
  safeStorageMock.encryptString.mockReset()
  safeStorageMock.decryptString.mockReset()
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
  safeStorageMock.encryptString.mockImplementation((value) => Buffer.from(`encrypted:${value}`))
  safeStorageMock.decryptString.mockImplementation((value) =>
    value.toString('utf8').replace(/^encrypted:/, '')
  )
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  vi.unstubAllEnvs()
})

describe('OrcaMulticaSecretStore', () => {
  it('encrypts with AES, decrypts, and deletes without persisting plaintext', async () => {
    const root = tempRoot()
    const store = new OrcaMulticaSecretStore(root)

    await store.set('multica:profile:production', 'mul_top_secret_value')
    expect(await store.get('multica:profile:production')).toBe('mul_top_secret_value')

    const persisted = readFileSync(join(root, 'secrets.json.enc'), 'utf8')
    expect(persisted).not.toContain('mul_top_secret_value')
    expect(JSON.parse(persisted)).toMatchObject({
      version: 1,
      ciphertexts: {
        'multica:profile:production': { provider: 'aes-256-gcm-v1' }
      }
    })

    await store.delete('multica:profile:production')
    expect(await store.get('multica:profile:production')).toBeNull()
  })

  it('fails closed when an AES ciphertext is read without the configured key', async () => {
    const root = tempRoot()
    await new OrcaMulticaSecretStore(root).set('multica:profile:server', 'mul_secret')
    vi.stubEnv('ORCA_MULTICA_MASTER_KEY', '')

    await expect(
      new OrcaMulticaSecretStore(root).get('multica:profile:server')
    ).rejects.toThrow('ORCA_MULTICA_MASTER_KEY is required')
  })

  it('uses OS-backed encryption when no master key is configured', async () => {
    vi.stubEnv('ORCA_MULTICA_MASTER_KEY', '')
    const store = new OrcaMulticaSecretStore(tempRoot())

    await store.set('multica:profile:desktop', 'mul_desktop_secret')
    expect(await store.get('multica:profile:desktop')).toBe('mul_desktop_secret')
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith('mul_desktop_secret')
    expect(safeStorageMock.decryptString).toHaveBeenCalledOnce()
  })

  it('writes no plaintext when neither protected provider is available', async () => {
    vi.stubEnv('ORCA_MULTICA_MASTER_KEY', '')
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const root = tempRoot()
    const store = new OrcaMulticaSecretStore(root)

    await expect(store.set('multica:profile:missing', 'plaintext')).rejects.toThrow(
      'No protected Multica secret provider is available'
    )
    expect(() => readFileSync(join(root, 'secrets.json.enc'), 'utf8')).toThrow()
  })
})
