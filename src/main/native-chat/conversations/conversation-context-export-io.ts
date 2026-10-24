import type { FileHandle } from 'node:fs/promises'
import { ConversationExportError } from './conversation-artifact-disclosure'
export async function writeConversationExportBytes(
  handle: FileHandle,
  bytes: Uint8Array,
  signal?: AbortSignal
): Promise<void> {
  let offset = 0
  while (offset < bytes.length) {
    signal?.throwIfAborted()
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset)
    if (bytesWritten === 0) {
      throw new ConversationExportError('corrupt-source')
    }
    offset += bytesWritten
  }
}
