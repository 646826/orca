import { callRuntimeRpc } from './runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  getRuntimeEnvironmentRevision,
  onRuntimeEnvironmentsRetired,
  onRuntimeEnvironmentRevisionsChanged
} from './runtime-environment-revision'

import { ConversationReaderOwnerChangedError } from '../../../shared/conversation-history-rpc-schema'
export { ConversationReaderOwnerChangedError } from '../../../shared/conversation-history-rpc-schema'
/** A reader never follows a reused pairing alias, even while an old request is in flight. */
export function captureConversationReaderOwner(target: RuntimeClientTarget) {
  const revision =
    target.kind === 'environment' ? getRuntimeEnvironmentRevision(target.environmentId) : undefined
  let retired = false
  const current = () =>
    target.kind === 'local' ||
    (!retired &&
      revision !== undefined &&
      revision === getRuntimeEnvironmentRevision(target.environmentId))
  const assertCurrent = () => {
    if (!current()) {
      throw new ConversationReaderOwnerChangedError()
    }
  }
  return {
    async request<T>(
      method: string,
      params: unknown,
      options?: { signal?: AbortSignal }
    ): Promise<T> {
      assertCurrent()
      const result = await callRuntimeRpc<T>(target, method, params, {
        expectedEnvironmentPairingRevision: revision,
        ...options,
        beforeSend: assertCurrent
      })
      assertCurrent()
      return result
    },
    options: { expectedEnvironmentPairingRevision: revision },
    current,
    assertCurrent,
    subscribe(lost: () => void) {
      if (target.kind === 'local') {
        return () => {}
      }
      const invalidate = (ids: readonly string[]) => {
        if (!ids.includes(target.environmentId) || retired) {
          return
        }
        retired = true
        lost()
      }
      const stopRetired = onRuntimeEnvironmentsRetired(invalidate)
      const stopChanged = onRuntimeEnvironmentRevisionsChanged(invalidate)
      return () => {
        stopRetired()
        stopChanged()
      }
    }
  }
}
