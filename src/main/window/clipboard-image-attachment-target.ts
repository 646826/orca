import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { assertClipboardImageByteLengthWithinLimit } from '../../shared/clipboard-image'
import { agentSessionPastedImageName } from '../../shared/agent-session-attachments'
import {
  saveClipboardImageBufferAsTempFile,
  type SaveClipboardImageAsTempFileArgs
} from './clipboard-image-temp-file'
import { saveClipboardImageBufferInRuntime } from './clipboard-runtime-image-upload'
import { uploadPasteToAgentSessionAttachments } from '../ipc/agent-session-attachment-upload'
import type { ClipboardHandlerOptions } from './clipboard-ipc-handlers'

export async function saveClipboardImageBufferForTarget(
  buffer: Buffer,
  args: SaveClipboardImageAsTempFileArgs | undefined,
  options: ClipboardHandlerOptions
): Promise<string> {
  assertClipboardImageByteLengthWithinLimit(buffer.byteLength)
  const runtimeEnvironmentId = args?.runtimeEnvironmentId?.trim()
  // A structured chat on a paired server keeps its pasted images in that server's store.
  if (runtimeEnvironmentId && args?.agentSessionAttachment) {
    return uploadPasteToAgentSessionAttachments(
      args.agentSessionAttachment,
      runtimeEnvironmentId,
      app.getPath('userData'),
      buffer
    )
  }
  // Why (#17679): with a runtime owner, a connectionId names one of the RUNTIME's SSH
  // connections (nested Remote Server -> SSH), not one this process dialed. Looking it up
  // in the local provider registry can only miss, so the runtime must perform the save.
  if (runtimeEnvironmentId) {
    return saveClipboardImageBufferInRuntime(
      app.getPath('userData'),
      runtimeEnvironmentId,
      buffer,
      args?.connectionId ?? null
    )
  }
  // A local structured chat's paste goes in this machine's chat store: a send claims it for its
  // chat, and only an unclaimed one is ever swept. Any other composer paste keeps the paste folder.
  if (args?.forNativeChatDraft === true && args.forStructuredChat === true && !args.connectionId) {
    const store = await options.localChatAttachmentStore?.().catch(() => null)
    if (store) {
      return store.storeFile(
        agentSessionPastedImageName(Date.now(), randomUUID()),
        buffer,
        args.localAttachmentOwner
      )
    }
  }
  return saveClipboardImageBufferAsTempFile(buffer, args)
}
