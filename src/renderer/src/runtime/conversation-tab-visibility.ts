import type { ConversationTabLifetime } from './conversation-tab-lifetime'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  ConversationSurfaceSnapshotSchema,
  type ConversationSurfaceSnapshot
} from '../../../shared/conversation-surface-rpc'
import { callRuntimeRpc } from './runtime-rpc-client'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

export type ClosedConversationTab = {
  target: RuntimeClientTarget
  conversationId: string
  /** Canonical host surface ID, not this renderer's mirrored pane ID. */
  tabId: string
  workspaceId: string
  pairingRevision?: number
}

/** Changes only the host-owned visible surface, never a native participant or archive. */
export async function setConversationTabVisibility(
  reference: ClosedConversationTab,
  visible: boolean,
  lifetime?: ConversationTabLifetime
): Promise<ConversationSurfaceSnapshot> {
  const ref = { ...reference, target: { ...reference.target } }
  if (ref.target.kind === 'environment' && ref.pairingRevision === undefined) {
    throw new Error('Conversation host pairing unavailable')
  }
  lifetime?.assertCurrent()
  const options = {
    expectedEnvironmentPairingRevision: ref.pairingRevision,
    signal: lifetime?.signal,
    beforeSend: lifetime?.assertCurrent
  }
  function checked(raw: unknown) {
    lifetime?.assertCurrent()
    const result = ConversationSurfaceSnapshotSchema.parse(raw)
    const surface = result.surface
    // RPC journal locations are host-local; the target and pairing fence identify that host.
    const host = LOCAL_EXECUTION_HOST_ID
    if (
      !surface ||
      result.conversation.conversationId !== ref.conversationId ||
      surface.conversationId !== ref.conversationId ||
      surface.tabId !== ref.tabId ||
      surface.location.workspaceId !== ref.workspaceId ||
      surface.location.executionHostId !== host ||
      result.conversation.location.workspaceId !== ref.workspaceId ||
      result.conversation.location.executionHostId !== host
    ) {
      throw new Error('Conversation surface owner changed')
    }
    return result
  }
  const read = async () =>
    checked(
      await callRuntimeRpc(
        ref.target,
        'conversation.surfaceRead',
        { conversationId: ref.conversationId },
        options
      )
    )
  const current = await read()
  if (!current.surface) {
    throw new Error('Conversation surface unavailable')
  }
  let result: ConversationSurfaceSnapshot
  try {
    result = checked(
      await callRuntimeRpc(
        ref.target,
        'conversation.setSurfaceVisibility',
        {
          conversationId: ref.conversationId,
          expectedSurfaceRevision: current.surface.surfaceRevision,
          visible
        },
        options
      )
    )
  } catch (error) {
    // No blind retry: a newer opposite choice from another window must not be overwritten.
    const reconciled = await read()
    if (
      reconciled.surface?.visible !== visible ||
      reconciled.surface.publishedRevision !== reconciled.surface.surfaceRevision
    ) {
      throw error
    }
    result = reconciled
  }
  if (
    result.surface?.visible !== visible ||
    result.surface.publishedRevision !== result.surface.surfaceRevision
  ) {
    throw new Error('Conversation surface publication is incomplete')
  }
  return result
}

/** Apply the same authoritative session-tab frame used by ordinary host tabs. */
export async function refreshConversationTabLayout(
  ref: ClosedConversationTab,
  lifetime?: ConversationTabLifetime
): Promise<void> {
  lifetime?.assertCurrent()
  if (ref.target.kind === 'environment') {
    const { refreshWebRuntimeSessionTabsSnapshot } = await import('./web-runtime-session-snapshot')
    await refreshWebRuntimeSessionTabsSnapshot(ref.target.environmentId, ref.workspaceId, {
      assertCurrent: lifetime?.assertCurrent,
      errorMode: 'throw',
      acceptCurrentSnapshot: true,
      afterCurrentInFlight: true,
      expectedEnvironmentPairingRevision: ref.pairingRevision
    })
  } else {
    const { refreshLocalStructuredSessionWorktreeTabs } =
      await import('./local-structured-session-tabs-sync/inventory-refresh')
    await refreshLocalStructuredSessionWorktreeTabs(ref.workspaceId, {
      assertCurrent: lifetime?.assertCurrent,
      reacceptCurrentVersion: true
    })
  }
}
