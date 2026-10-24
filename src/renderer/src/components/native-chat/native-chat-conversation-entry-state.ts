import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { ConversationRecord } from '../../../../shared/conversation-record'
import type { ConversationSelectAgentRequest } from '../../../../shared/conversation-surface-rpc'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { ensureLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import { NATIVE_CONVERSATION_RUNTIME_CAPABILITY } from '../../../../shared/conversation-runtime-capabilities'
import { ConversationRpcRefusal } from '../../../../shared/conversation-rpc-refusal'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import { executionHostIdForStructuredTarget } from '@/runtime/structured-agent-session-owner'
import {
  getRuntimeEnvironmentRevision,
  onRuntimeEnvironmentsRetired,
  resolveContinuedRuntimeEnvironmentRevision
} from '@/runtime/runtime-environment-revision'

export type ConversationEntryAttempt = {
  target: RuntimeClientTarget
  tabId: string
  sessionId: string
  agent: ConversationSelectAgentRequest['agent']
  kind: 'entry' | 'rebuild'
  workspaceId: string
  pairingRevision: number | undefined
  lifetime: AbortController
  operationId: string
  busy: boolean
  error: unknown
  conversation?: ConversationRecord
  sourceTabId?: string
  selection?: ConversationSelectAgentRequest
}

const attempts = new Map<string, ConversationEntryAttempt>()
const listeners = new Set<() => void>()
const key = (target: RuntimeClientTarget, tabId: string) => JSON.stringify([target, tabId])
function notify() {
  for (const listener of listeners) {
    listener()
  }
}
export function readConversationEntry(target: RuntimeClientTarget, tabId: string) {
  return attempts.get(key(target, tabId)) ?? null
}
export function subscribeConversationEntry(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function createConversationEntryLifetime(target: RuntimeClientTarget) {
  const pairingRevision =
    target.kind === 'environment' ? getRuntimeEnvironmentRevision(target.environmentId) : undefined
  return { lifetime: new AbortController(), pairingRevision }
}
export function installConversationEntry(attempt: ConversationEntryAttempt) {
  attempts.set(key(attempt.target, attempt.tabId), attempt)
  notify()
}
export function publishConversationEntry(attempt: ConversationEntryAttempt) {
  if (
    attempt.lifetime.signal.aborted ||
    readConversationEntry(attempt.target, attempt.tabId)?.lifetime !== attempt.lifetime
  ) {
    return
  }
  attempts.set(key(attempt.target, attempt.tabId), attempt)
  notify()
}
export function releaseConversationEntry(attempt: ConversationEntryAttempt) {
  if (readConversationEntry(attempt.target, attempt.tabId)?.lifetime !== attempt.lifetime) {
    return
  }
  attempt.lifetime.abort()
  attempts.delete(key(attempt.target, attempt.tabId))
  notify()
}
export function conversationEntryRpcOptions(attempt: ConversationEntryAttempt) {
  return {
    signal: attempt.lifetime.signal,
    expectedEnvironmentPairingRevision: attempt.pairingRevision,
    beforeSend: () => {
      attempt.lifetime.signal.throwIfAborted()
      if (attempt.target.kind === 'environment' && attempt.pairingRevision === undefined) {
        throw new Error('Runtime host pairing was unavailable when this request began')
      }
      if (
        attempt.target.kind === 'environment' &&
        resolveContinuedRuntimeEnvironmentRevision(
          attempt.target.environmentId,
          attempt.pairingRevision
        ) !== getRuntimeEnvironmentRevision(attempt.target.environmentId)
      ) {
        throw new Error('Runtime host pairing changed during conversation entry')
      }
      if (readConversationEntry(attempt.target, attempt.tabId)?.lifetime !== attempt.lifetime) {
        throw new Error('Conversation entry scope was removed')
      }
    }
  }
}
export async function callConversationEntry(
  attempt: ConversationEntryAttempt,
  method: string,
  params: unknown
): Promise<unknown> {
  const options = conversationEntryRpcOptions(attempt)
  options.beforeSend()
  const supported = await waitForPromiseWithSignal(
    attempt.target.kind === 'local'
      ? ensureLocalRuntimeCapabilities().then(
          (capabilities) => capabilities?.includes(NATIVE_CONVERSATION_RUNTIME_CAPABILITY) === true
        )
      : runtimeEnvironmentSupportsCapability(
          attempt.target.environmentId,
          NATIVE_CONVERSATION_RUNTIME_CAPABILITY
        ),
    attempt.lifetime.signal
  )
  options.beforeSend()
  if (!supported) {
    throw new ConversationRpcRefusal('unsupported')
  }
  const result = await callRuntimeRpc(attempt.target, method, params, options)
  options.beforeSend()
  return result
}
/** Only confirmed workspace teardown calls this; hide/unmount/disconnect retain request identities. */
export function forgetConversationEntriesOwnedBy(owner: {
  workspaceId: string
  executionHostId: ExecutionHostId
}) {
  for (const attempt of attempts.values()) {
    if (
      attempt.workspaceId === owner.workspaceId &&
      executionHostIdForStructuredTarget(attempt.target) === owner.executionHostId
    ) {
      releaseConversationEntry(attempt)
    }
  }
}
onRuntimeEnvironmentsRetired((ids) => {
  const retired = new Set(ids)
  for (const attempt of attempts.values()) {
    if (attempt.target.kind === 'environment' && retired.has(attempt.target.environmentId)) {
      releaseConversationEntry(attempt)
    }
  }
})

/** Shared by explicit and authoritative host-scoped workspace purge paths. */
export function forgetConversationEntriesForWorkspaces(
  workspaceIds: ReadonlySet<string>,
  ownedByHost?: (workspaceId: string, hostId: ExecutionHostId) => boolean
) {
  for (const attempt of attempts.values()) {
    const hostId = executionHostIdForStructuredTarget(attempt.target)
    if (
      workspaceIds.has(attempt.workspaceId) &&
      (!ownedByHost || ownedByHost(attempt.workspaceId, hostId))
    ) {
      releaseConversationEntry(attempt)
    }
  }
}
