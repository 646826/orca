import { randomUUID } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { lstat, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import { sanitizeAgentSessionAttachmentName } from '../../../shared/agent-session-attachments'
import { renameFileWithWindowsRetryAsync } from '../../../shared/windows-retry-file-operations'
import { AGENT_SESSION_ATTACHMENT_PART_FILE } from './agent-session-attachment-references'
import type { AgentSessionUploadOwnership } from './agent-session-upload-provenance'
const FRESH_FILE_STREAM_HIGH_WATER_MARK = 1024 * 1024
export async function importFreshAttachmentFile(
  rootDir: string,
  name: string,
  sourcePath: string,
  byteLength: number,
  ownership?: AgentSessionUploadOwnership,
  scope?: { sessionId: string }
): Promise<string> {
  const owner = scope && ownership?.capture(scope.sessionId)
  const uploadId = randomUUID()
  if (owner) {
    ownership!.begin({
      uploadId,
      name: sanitizeAgentSessionAttachmentName(name),
      byteLength,
      owner
    })
  }
  const uploadDir = join(rootDir, uploadId)
  const finalPath = join(uploadDir, sanitizeAgentSessionAttachmentName(name))
  try {
    await mkdir(uploadDir, { recursive: true })
    try {
      // The internal exporter owns unscoped snapshots; user intake also commits ownership.
      await renameFileWithWindowsRetryAsync(sourcePath, finalPath)
      if (owner) {
        ownership!.commit(uploadId, owner)
      }
      return finalPath
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EXDEV')) {
        throw error
      }
    }
    const partPath = join(uploadDir, AGENT_SESSION_ATTACHMENT_PART_FILE)
    const handle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size !== byteLength) {
        throw new Error('Snapshot changed')
      }
      await (byteLength === 0
        ? writeFile(partPath, '', { flag: 'wx', mode: 0o600 })
        : pipeline(
            handle.createReadStream({
              start: 0,
              end: byteLength - 1,
              autoClose: false,
              highWaterMark: FRESH_FILE_STREAM_HIGH_WATER_MARK
            }),
            createWriteStream(partPath, {
              flags: 'wx',
              mode: 0o600,
              highWaterMark: FRESH_FILE_STREAM_HIGH_WATER_MARK
            })
          ))
      const after = await handle.stat()
      if (
        (await lstat(partPath)).size !== byteLength ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ino !== before.ino ||
        after.dev !== before.dev
      ) {
        throw new Error('Snapshot changed')
      }
    } finally {
      await handle.close()
    }
    await renameFileWithWindowsRetryAsync(partPath, finalPath)
    if (owner) {
      ownership!.commit(uploadId, owner)
    }
    return finalPath
  } catch (error) {
    await removeQuietly(uploadDir)
    throw error
  }
}
export async function removeQuietly(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => {})
}
