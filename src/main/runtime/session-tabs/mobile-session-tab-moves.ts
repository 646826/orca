import type { RuntimeHeadlessTabGroups as HeadlessTabGroupsMethods } from './headless-tab-group-moves'
import type { OrcaRuntimeWithPersistHeadlessTerminalTitle as PersistHeadlessTerminalTitleMethods } from '../workspaces/workspace-file-session-targets'
import { OrcaRuntimeWithMainLayoutTabMoves } from './main-layout-session-tab-move'
import type {
  RuntimeMobileSessionTabMove,
  RuntimeMobileSessionTabMoveResult
} from '../../../shared/runtime-types'

export abstract class OrcaRuntimeWithMobileSessionTabMoves extends OrcaRuntimeWithMainLayoutTabMoves {
  protected abstract moveHeadlessMobileSessionTab(
    ...args: Parameters<HeadlessTabGroupsMethods['moveHeadlessMobileSessionTab']>
  ): ReturnType<HeadlessTabGroupsMethods['moveHeadlessMobileSessionTab']>

  protected abstract normalizeMobileSessionTabOrder(
    ...args: Parameters<PersistHeadlessTerminalTitleMethods['normalizeMobileSessionTabOrder']>
  ): ReturnType<PersistHeadlessTerminalTitleMethods['normalizeMobileSessionTabOrder']>

  async moveMobileSessionTab(
    worktreeSelector: string,
    move: RuntimeMobileSessionTabMove,
    assertAgentSessionMutation?: (sessionId: string) => void
  ): Promise<RuntimeMobileSessionTabMoveResult> {
    const explicitWorktreeId = this.getExplicitSessionWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      throw new Error('tab_not_found')
    }
    const assertMutation = () => {
      if (!assertAgentSessionMutation) {
        return
      }
      const tab = snapshot.tabs.find((row) => row.id === move.tabId)
      if (tab?.type === 'agent-session') {
        assertAgentSessionMutation?.(tab.sessionId)
      }
    }
    assertMutation()
    const movedInMain = await this.moveTabInMainLayout(worktreeId, snapshot, move, assertMutation)
    assertMutation()
    if (movedInMain) {
      return movedInMain
    }
    if (!this.notifier?.moveSessionTab) {
      return this.moveHeadlessMobileSessionTab(worktreeId, snapshot, move)
    }
    const hostTabId = this.resolveMobileSessionHostTabId(snapshot, move.tabId)
    if (!hostTabId) {
      throw new Error('tab_not_found')
    }
    const publicSnapshot = this.toMobileSessionTabsResult(snapshot)
    const targetGroup = publicSnapshot.tabGroups?.find((group) => group.id === move.targetGroupId)
    if (!targetGroup) {
      throw new Error('target_group_not_found')
    }

    // Why: web clients address terminal surfaces as tab::leaf, while desktop
    // tab grouping is owned by the outer terminal tab id.
    if (move.kind === 'reorder') {
      const tabOrder = this.normalizeMobileSessionTabOrder(snapshot, targetGroup, move.tabOrder)
      if (!tabOrder.includes(hostTabId)) {
        throw new Error('invalid_tab_order')
      }
      this.notifier.moveSessionTab(worktreeId, {
        ...move,
        tabId: hostTabId,
        tabOrder
      })
      return { moved: true }
    }
    this.notifier.moveSessionTab(worktreeId, {
      ...move,
      tabId: hostTabId
    })
    return { moved: true }
  }
}
