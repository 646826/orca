import { captureConversationTabLifetime } from '@/runtime/conversation-tab-lifetime'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { Tab } from '../../../../../shared/tab-types'
import type { AppState } from '../../types'
import {
  structuredAgentSessionTargetForTab,
  structuredAgentSessionFocusOwner
} from '@/runtime/structured-agent-session-owner'
import { resolveHostSessionTabIdForWebSessionTab } from '@/runtime/web-session-tabs-sync/tracking-mappings'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { beginPendingTab, isTabClosePending } from '@/runtime/layout-owner-pending-tabs'
import {
  setConversationTabVisibility,
  refreshConversationTabLayout,
  type ClosedConversationTab
} from '@/runtime/conversation-tab-visibility'
import { selectAfterClose } from './content-tab-close-through-layout-owner'

export function beginConversationTabClose(
  get: () => AppState,
  tab: Tab,
  landIfEmptied?: () => boolean,
  preserveSelection = false
): null {
  if (isTabClosePending(tab.id)) {
    return null
  }
  const target = structuredAgentSessionTargetForTab(get(), tab)
  if (!target) {
    reportConversationVisibilityFailure()
    return null
  }
  const reference: ClosedConversationTab = {
    target,
    tabId:
      resolveHostSessionTabIdForWebSessionTab(get(), {
        ...structuredAgentSessionFocusOwner(target),
        worktreeId: tab.worktreeId,
        tabId: tab.id
      }) ?? tab.id,
    conversationId: tab.entityId,
    workspaceId: tab.worktreeId,
    ...(target.kind === 'environment'
      ? { pairingRevision: getRuntimeEnvironmentRevision(target.environmentId) }
      : {})
  }
  const settle = beginPendingTab(tab.id, tab.worktreeId, tab.entityId, { kind: 'close' })
  void (async () => {
    let frameClosed = false
    let lifetime: ReturnType<typeof captureConversationTabLifetime> | undefined
    try {
      lifetime = captureConversationTabLifetime(get, reference)
      await setConversationTabVisibility(reference, false, lifetime)
      lifetime.assertCurrent()
      get().rememberClosedConversationTab(reference)
      await refreshConversationTabLayout(reference, lifetime)
      lifetime.assertCurrent()
      if (get().unifiedTabsByWorktree[tab.worktreeId]?.some((entry) => entry.id === tab.id)) {
        throw new Error('Conversation close frame unavailable')
      }
      frameClosed = true
      if (!preserveSelection && !landIfEmptied?.()) {
        selectAfterClose(get, tab, null)
      }
    } catch {
      if (!lifetime || lifetime.canRetainReference()) {
        reportConversationVisibilityFailure()
      }
    } finally {
      lifetime?.close()
      settle(frameClosed ? tab.id : null)
    }
  })()
  return null
}
export function reportConversationVisibilityFailure(): void {
  toast.error(
    translate(
      'components.native-chat.agentSwitch.surfaceChangeUnconfirmed',
      'The conversation view change could not be confirmed. Retry to check the host; its history and native sessions have not been deleted.'
    )
  )
}
