import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import { NATIVE_CONVERSATION_RUNTIME_CAPABILITY } from '../../../shared/conversation-runtime-capabilities'
import { createRemoteConversationSurfaceInventory } from './remote-conversation-surface-inventory'

const inventory = createRemoteConversationSurfaceInventory()
const streams = new Map<
  string,
  { stream: ReturnType<typeof inventory.open>; invalidate: () => boolean }
>()

/** Called only by the authenticated main-process subscription relay, never by an IPC payload. */
export function openRemoteConversationInventory(
  environmentId: string,
  generation: number,
  runtimeId: string | undefined,
  onInvalidated?: () => void
) {
  const stream = inventory.open(environmentId, generation)
  let established = false
  let invalidated = false
  const invalidate = () => {
    if (!established) {
      return false
    }
    inventory.close(stream)
    if (established && !invalidated) {
      invalidated = true
      onInvalidated?.()
    }
    return true
  }
  streams.set(environmentId, { stream, invalidate })
  return {
    record(response: RuntimeRpcResponse<unknown>, currentGeneration: number) {
      if (!runtimeId || !response.ok || response._meta?.runtimeId !== runtimeId) {
        inventory.close(stream)
        return
      }
      const hadAuthority = inventory.read(environmentId, currentGeneration) !== null
      inventory.record(stream, response.result, currentGeneration)
      const hasAuthority = inventory.read(environmentId, currentGeneration) !== null
      established ||= hasAuthority
      if (hadAuthority && !hasAuthority) {
        invalidate()
      }
    },
    close() {
      inventory.close(stream)
      if (streams.get(environmentId)?.stream === stream) {
        streams.delete(environmentId)
      }
    }
  }
}

export function observeRemoteConversationStatus(snapshot: RuntimeHostStatusSnapshot): void {
  if (
    snapshot.verification !== 'verified' ||
    snapshot.retired ||
    !snapshot.status?.capabilities?.includes(NATIVE_CONVERSATION_RUNTIME_CAPABILITY)
  ) {
    const stream = streams.get(snapshot.environmentId)
    if (stream?.invalidate()) {
      streams.delete(snapshot.environmentId)
    }
  }
}
export const readRemoteConversationInventory = inventory.read
