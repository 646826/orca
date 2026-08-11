import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { safeStorage } from 'electron'
import { writeSecureFile } from '../../shared/secure-file'
import {
  assertLificSecretReference,
  emptyLificSecretFile,
  LIFIC_SECRET_FILE_MAX_BYTES,
  parseLificSecretFile,
  type LificSecretFile
} from '../../shared/lific/lific-secret-file'
import type { LificSecretStore } from '../../shared/lific/lific-types'
import { resolveLificDataDirectory } from './lific-state-store'

const MAX_SECRET_FILE_BYTES = LIFIC_SECRET_FILE_MAX_BYTES

function masterKey(): Buffer | null {
  const value = process.env.ORCA_LIFIC_MASTER_KEY?.trim()
  if (!value) {
    return null
  }
  if (value.length < 32) {
    throw new Error('ORCA_LIFIC_MASTER_KEY must contain at least 32 characters')
  }
  return createHash('sha256').update(value, 'utf8').digest()
}

export class OrcaLificSecretStore implements LificSecretStore {
  readonly #filePath: string

  constructor(dataDirectory = resolveLificDataDirectory()) {
    this.#filePath = join(dataDirectory, 'secrets.json.enc')
  }

  #read(): LificSecretFile {
    if (!existsSync(this.#filePath)) {
      return emptyLificSecretFile()
    }
    return parseLificSecretFile(readFileSync(this.#filePath, 'utf8'), MAX_SECRET_FILE_BYTES)
  }

  #write(file: LificSecretFile): void {
    const text = JSON.stringify(file, null, 2)
    if (Buffer.byteLength(text, 'utf8') > MAX_SECRET_FILE_BYTES) {
      throw new Error(`Lific secret store exceeds ${MAX_SECRET_FILE_BYTES} bytes`)
    }
    mkdirSync(dirname(this.#filePath), { recursive: true })
    writeSecureFile(this.#filePath, text)
  }

  getSync(reference: string): string | null {
    const safeReference = assertLificSecretReference(reference)
    const ciphertext = this.#read().ciphertexts[safeReference]
    if (!ciphertext) {
      return null
    }
    if (ciphertext.provider === 'aes-256-gcm-v1') {
      const key = masterKey()
      if (!key) {
        throw new Error('ORCA_LIFIC_MASTER_KEY is required to decrypt this host secret')
      }
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ciphertext.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(ciphertext.tag, 'base64'))
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext.data, 'base64')),
        decipher.final()
      ]).toString('utf8')
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-backed encryption is unavailable for the stored Lific secret')
    }
    return safeStorage.decryptString(Buffer.from(ciphertext.data, 'base64'))
  }

  async get(reference: string): Promise<string | null> {
    return this.getSync(reference)
  }

  async set(reference: string, value: string): Promise<void> {
    const safeReference = assertLificSecretReference(reference)
    if (!value) {
      throw new Error('Lific secret value is required')
    }
    const file = this.#read()
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
      this.#write(file)
      return
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        'No protected secret provider is available. Enable OS encryption or set ORCA_LIFIC_MASTER_KEY on this runtime.'
      )
    }
    file.ciphertexts[safeReference] = {
      provider: 'electron-safe-storage-v1',
      data: safeStorage.encryptString(value).toString('base64')
    }
    this.#write(file)
  }

  async delete(reference: string): Promise<void> {
    const safeReference = assertLificSecretReference(reference)
    const file = this.#read()
    if (Object.hasOwn(file.ciphertexts, safeReference)) {
      delete file.ciphertexts[safeReference]
      this.#write(file)
    }
  }
}