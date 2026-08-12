import { describe, expect, it } from 'vitest'
import {
  MULTICA_SECRET_FILE_MAX_BYTES,
  assertMulticaSecretReference,
  emptyMulticaSecretFile,
  parseMulticaSecretFile
} from './multica-secret-file'

describe('Multica secret file', () => {
  it.each(['', ' production', 'production ', 'x'.repeat(257), '__proto__', 'prototype', 'constructor'])(
    'rejects unsafe reference %j',
    (reference) => {
      expect(() => assertMulticaSecretReference(reference)).toThrow(
        'Invalid Multica secret reference'
      )
    }
  )

  it('accepts an opaque profile reference', () => {
    expect(assertMulticaSecretReference('multica:profile:production')).toBe(
      'multica:profile:production'
    )
  })

  it('creates an empty versioned secret file', () => {
    expect(emptyMulticaSecretFile()).toEqual({ version: 1, ciphertexts: {} })
  })

  it('parses both supported ciphertext providers', () => {
    expect(
      parseMulticaSecretFile(
        JSON.stringify({
          version: 1,
          ciphertexts: {
            'multica:profile:desktop': {
              provider: 'electron-safe-storage-v1',
              data: 'encrypted'
            },
            'multica:profile:server': {
              provider: 'aes-256-gcm-v1',
              data: 'encrypted',
              iv: 'iv',
              tag: 'tag'
            }
          }
        })
      )
    ).toEqual({
      version: 1,
      ciphertexts: {
        'multica:profile:desktop': {
          provider: 'electron-safe-storage-v1',
          data: 'encrypted'
        },
        'multica:profile:server': {
          provider: 'aes-256-gcm-v1',
          data: 'encrypted',
          iv: 'iv',
          tag: 'tag'
        }
      }
    })
  })

  it('rejects invalid, unsupported, and oversized documents', () => {
    expect(() => parseMulticaSecretFile('{')).toThrow(
      'Multica secret store contains invalid JSON'
    )
    expect(() => parseMulticaSecretFile('{"version":2,"ciphertexts":{}}')).toThrow(
      'Invalid Multica secret store document'
    )
    expect(() =>
      parseMulticaSecretFile('x'.repeat(MULTICA_SECRET_FILE_MAX_BYTES + 1))
    ).toThrow('Multica secret store exceeds')
  })
})
