import { createHash } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Host fixture policy for generated public synthetic bytes, never a native account grant. */
export function createSyntheticBenchmarkDisclosure(version) {
  const expected = Object.freeze({ ...version })
  const targetBindingDigest = createHash('sha256')
    .update(
      JSON.stringify({
        target: 'synthetic-benchmark-only',
        conversationId: 'benchmark',
        contextGeneration: 1
      })
    )
    .digest('hex')
  return {
    targetBindingDigest,
    resolve(candidate) {
      if (
        ['uploadId', 'name', 'sha256', 'byteLength'].some((key) => candidate[key] !== expected[key])
      ) {
        return null
      }
      return {
        version: expected,
        conversationId: 'benchmark',
        contextGeneration: 1,
        targetBindingDigest,
        action: 'include'
      }
    }
  }
}

export async function createBenchmarkRunDirectory(path) {
  await mkdir(dirname(path), { recursive: true })
  await mkdir(path)
}

export async function createBenchmarkArtifact(path, byteLength) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error('Invalid fixture size')
  }
  const file = await open(path, 'wx', 0o600)
  const hash = createHash('sha256')
  const block = Buffer.alloc(64 * 1024, 65)
  try {
    for (let position = 0; position < byteLength;) {
      const chunk = block.subarray(0, Math.min(block.length, byteLength - position))
      let written = 0
      while (written < chunk.length) {
        const { bytesWritten } = await file.write(chunk, written, chunk.length - written)
        if (!bytesWritten) {
          throw new Error('Fixture write made no progress')
        }
        written += bytesWritten
      }
      hash.update(chunk)
      position += chunk.length
    }
    await file.sync()
  } finally {
    await file.close()
  }
  return { path, byteLength, sha256: hash.digest('hex'), encoding: 'synthetic repeated ASCII A' }
}
