import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { safeStorage } from 'electron'
import { writeSecureFile } from '../../shared/secure-file'
import {
  assertMulticaSecretReference,
  emptyMulticaSecretFile,
  MULTICA_SECRET_FILE_MAX_BYTES,
  parseMulticaSecretFile,
  type MulticaSecretFile
} from '../../shared/multica/multica-secret-file'
import { resolveMulticaDataDirectory } from './multica-state-store'

const MAX_SECRET_FILE_BYTES = MULTICA_SECRET_FILE_MAX_BYTES

function masterKey(): Buffer | null {
  const value = process.env.ORCA_MULTICA_MASTER_KEY?.trim()
  if (!value) {
    return null
  }
  if (value.length < 32) {
    throw new Error('ORCA_MULTICA_MASTER_KEY must contain at least 32 characters')
  }
  return createHash('sha256').update(value, 'utf8').digest()
}

export class OrcaMulticaSecretStore {
  readonly #filePath: string
  #writeChain: Promise<void> = Promise.resolve()

  constructor(dataDirectory = resolveMulticaDataDirectory()) {
    this.#filePath = join(dataDirectory, 'secrets.json.enc')
  }

  getSync(reference: string): string | null {
    const safeReference = assertMulticaSecretReference(reference)
    const ciphertext = this.#read().ciphertexts[safeReference]
    if (!ciphertext) {
      return null
    }
    if (ciphertext.provider === 'aes-256-gcm-v1') {
      const key = masterKey()
      if (!key) {
        throw new Error('ORCA_MULTICA_MASTER_KEY is required to decrypt this host secret')
      }
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ciphertext.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(ciphertext.tag, 'base64'))
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext.data, 'base64')),
        decipher.final()
      ]).toString('utf8')
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-backed encryption is unavailable for the stored Multica secret')
    }
    return safeStorage.decryptString(Buffer.from(ciphertext.data, 'base64'))
  }

  async get(reference: string): Promise<string | null> {
    await this.#writeChain
    return this.getSync(reference)
  }

  async set(reference: string, value: string): Promise<void> {
    const safeReference = assertMulticaSecretReference(reference)
    if (!value) {
      throw new Error('Multica secret value is required')
    }
    await this.#mutate((file) => {
      const key = masterKey()
      if (key) {
        const iv = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', key, iv)
        const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
        file.ciphertexts[safeReference] = {
          provider: 'aes-256-gcm-v1',
          data: data.toString('base64'),
          iv: iv.toString('base64'),
          tag: cipher.getAuthTag().toString('base64')
        }
        return
      }
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error(
          'No protected Multica secret provider is available. Enable OS encryption or set ORCA_MULTICA_MASTER_KEY on this runtime.'
        )
      }
      file.ciphertexts[safeReference] = {
        provider: 'electron-safe-storage-v1',
        data: safeStorage.encryptString(value).toString('base64')
      }
    })
  }

  async delete(reference: string): Promise<void> {
    const safeReference = assertMulticaSecretReference(reference)
    await this.#mutate((file) => {
      delete file.ciphertexts[safeReference]
    }, false)
  }

  #read(): MulticaSecretFile {
    if (!existsSync(this.#filePath)) {
      return emptyMulticaSecretFile()
    }
    return parseMulticaSecretFile(readFileSync(this.#filePath, 'utf8'), MAX_SECRET_FILE_BYTES)
  }

  #write(file: MulticaSecretFile): void {
    const serialized = JSON.stringify(file, null, 2)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_SECRET_FILE_BYTES) {
      throw new Error(`Multica secret store exceeds ${MAX_SECRET_FILE_BYTES} bytes`)
    }
    mkdirSync(dirname(this.#filePath), { recursive: true })
    writeSecureFile(this.#filePath, serialized)
  }

  async #mutate(
    mutator: (file: MulticaSecretFile) => void,
    writeWhenUnchanged = true
  ): Promise<void> {
    const queued = this.#writeChain.then(() => {
      const file = this.#read()
      const before = writeWhenUnchanged ? '' : JSON.stringify(file)
      mutator(file)
      if (writeWhenUnchanged || JSON.stringify(file) !== before) {
        this.#write(file)
      }
    })
    this.#writeChain = queued.then(
      () => undefined,
      () => undefined
    )
    await queued
  }
}
