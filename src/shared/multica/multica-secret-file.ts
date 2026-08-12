export const MULTICA_SECRET_FILE_MAX_BYTES = 5 * 1024 * 1024

export type MulticaStoredCiphertext =
  | { provider: 'electron-safe-storage-v1'; data: string }
  | { provider: 'aes-256-gcm-v1'; data: string; iv: string; tag: string }

export type MulticaSecretFile = {
  version: 1
  ciphertexts: Record<string, MulticaStoredCiphertext>
}

const RESERVED_REFERENCES = new Set(['__proto__', 'prototype', 'constructor'])

export function assertMulticaSecretReference(reference: string): string {
  if (
    !reference ||
    reference !== reference.trim() ||
    reference.length > 256 ||
    RESERVED_REFERENCES.has(reference)
  ) {
    throw new Error('Invalid Multica secret reference')
  }
  return reference
}

export function emptyMulticaSecretFile(): MulticaSecretFile {
  return { version: 1, ciphertexts: {} }
}

export function parseMulticaSecretFile(
  text: string,
  maxBytes = MULTICA_SECRET_FILE_MAX_BYTES
): MulticaSecretFile {
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new Error(`Multica secret store exceeds ${maxBytes} bytes`)
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('Multica secret store contains invalid JSON')
  }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.ciphertexts)) {
    throw new Error('Invalid Multica secret store document')
  }

  const ciphertexts: Record<string, MulticaStoredCiphertext> = {}
  for (const [reference, rawCiphertext] of Object.entries(value.ciphertexts)) {
    assertMulticaSecretReference(reference)
    if (!isRecord(rawCiphertext) || typeof rawCiphertext.data !== 'string' || !rawCiphertext.data) {
      throw new Error(`Invalid ciphertext for Multica secret '${reference}'`)
    }
    if (rawCiphertext.provider === 'electron-safe-storage-v1') {
      ciphertexts[reference] = {
        provider: 'electron-safe-storage-v1',
        data: rawCiphertext.data
      }
      continue
    }
    if (
      rawCiphertext.provider === 'aes-256-gcm-v1' &&
      typeof rawCiphertext.iv === 'string' &&
      rawCiphertext.iv &&
      typeof rawCiphertext.tag === 'string' &&
      rawCiphertext.tag
    ) {
      ciphertexts[reference] = {
        provider: 'aes-256-gcm-v1',
        data: rawCiphertext.data,
        iv: rawCiphertext.iv,
        tag: rawCiphertext.tag
      }
      continue
    }
    throw new Error(`Invalid ciphertext for Multica secret '${reference}'`)
  }
  return { version: 1, ciphertexts }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
