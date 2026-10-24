import { createHash, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import {
  verifyConversationAttachment,
  type ConversationAttachmentVersion
} from '../agent-session-attachments/conversation-attachment-claims'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import { ConversationExportError } from './conversation-export-error'

const CHUNK_BYTES = 64 * 1024
const MAX_INDEX_BYTES = 4 * 1024 * 1024
export type ConversationEvidenceChunks = {
  read(offset: number, length: number): Promise<Buffer>
  close(): Promise<void>
}
/** Internal byte lease; target authority belongs to conversation-evidence-reader. */
export async function openConversationEvidenceChunks(input: {
  stateDirectory: string
  path: string
  version: ConversationAttachmentVersion
  assertAuthorized: () => void
  signal: AbortSignal
}): Promise<ConversationEvidenceChunks> {
  input = { ...input, version: { ...input.version } }
  let closed = false
  const check = () => {
    if (closed) {
      throw new ConversationExportError('scope')
    }
    input.signal.throwIfAborted()
    input.assertAuthorized()
  }
  check()
  const size = input.version.byteLength
  const count = Math.ceil(size / CHUNK_BYTES)
  if (!Number.isSafeInteger(size) || size < 0 || count * 32 > MAX_INDEX_BYTES) {
    throw new ConversationExportError('resource-limit')
  }
  const hashes = Buffer.alloc(count * 32)
  let chunkIndex = 0
  await verifyConversationAttachment({
    ...input,
    expected: input.version,
    indexChunkDigest: (chunk) => {
      check()
      if (
        chunk.offset !== chunkIndex * CHUNK_BYTES ||
        chunk.length !== Math.min(CHUNK_BYTES, size - chunk.offset)
      ) {
        throw new ConversationExportError('corrupt-source')
      }
      chunk.sha256.copy(hashes, chunkIndex++ * 32)
    }
  })
  check()
  if (chunkIndex !== count) {
    throw new ConversationExportError('corrupt-source')
  }
  const root = agentSessionAttachmentStoreRoot(input.stateDirectory)
  const directory = join(root, input.version.uploadId)
  const canonicalRoot = await realpath(root)
  const [rootStat, directoryStat, pathStat] = await Promise.all([
    lstat(root),
    lstat(directory),
    lstat(input.path)
  ])
  if (
    !rootStat.isDirectory() ||
    !directoryStat.isDirectory() ||
    !pathStat.isFile() ||
    (await realpath(directory)) !== join(canonicalRoot, input.version.uploadId) ||
    (await realpath(input.path)) !== join(canonicalRoot, input.version.uploadId, input.version.name)
  ) {
    throw new ConversationExportError('scope')
  }
  const handle = await open(
    input.path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  )
  let reading = false
  try {
    check()
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.size !== size ||
      opened.dev !== pathStat.dev ||
      opened.ino !== pathStat.ino
    ) {
      throw new ConversationExportError('corrupt-source')
    }
  } catch (error) {
    await handle.close()
    throw error
  }
  return {
    async read(offset, length) {
      check()
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        offset + length > size
      ) {
        throw new ConversationExportError('scope')
      }
      if (reading || length > CHUNK_BYTES) {
        throw new ConversationExportError('resource-limit')
      }
      reading = true
      try {
        const result = Buffer.alloc(length)
        const first = Math.floor(offset / CHUNK_BYTES)
        const last = Math.ceil((offset + length) / CHUNK_BYTES)
        for (let index = first; index < last; index++) {
          check()
          const start = index * CHUNK_BYTES
          const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, size - start))
          let read = 0
          while (read < bytes.length) {
            const { bytesRead } = await handle.read(bytes, read, bytes.length - read, start + read)
            check()
            if (!bytesRead) {
              throw new ConversationExportError('missing-source')
            }
            read += bytesRead
          }
          if (
            !timingSafeEqual(
              createHash('sha256').update(bytes).digest(),
              hashes.subarray(index * 32, (index + 1) * 32)
            )
          ) {
            throw new ConversationExportError('corrupt-source')
          }
          const from = Math.max(offset, start),
            to = Math.min(offset + length, start + bytes.length)
          bytes.copy(result, from - offset, from - start, to - start)
        }
        check()
        return result
      } catch (error) {
        check()
        throw error
      } finally {
        reading = false
      }
    },
    async close() {
      if (!closed) {
        closed = true
        await handle.close()
      }
    }
  }
}
