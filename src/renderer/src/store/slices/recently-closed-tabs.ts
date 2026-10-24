import { captureConversationTabLifetime } from '@/runtime/conversation-tab-lifetime'
import {
  executionHostIdForStructuredTarget,
  structuredAgentSessionFocusOwner,
  structuredAgentSessionOwnerForTab
} from '@/runtime/structured-agent-session-owner'
import { resolveLocalTabIdForHostSessionTab } from '@/runtime/web-session-tabs-sync/tracking-mappings'
import {
  setConversationTabVisibility,
  refreshConversationTabLayout,
  type ClosedConversationTab
} from '@/runtime/conversation-tab-visibility'
import { reportConversationVisibilityFailure } from './tabs/conversation-tab-close'
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/resolve-owner'
import {
  isWindowsAbsolutePathLike,
  relativePathInsideRoot
} from '../../../../shared/cross-platform-path'
import {
  restoreRecentlyClosedTabPosition,
  type RecentlyClosedTabPosition
} from './recently-closed-tab-position'

export {
  createRecentlyClosedTabPositionIndex,
  getRecentlyClosedTabPosition,
  insertTabAtRecentlyClosedPosition,
  restoreRecentlyClosedTabPosition
} from './recently-closed-tab-position'
export type {
  RecentlyClosedTabPosition,
  RecentlyClosedTabPositionIndex
} from './recently-closed-tab-position'

/** Snapshot of a terminal tab captured at user-initiated close time. Reopen
 *  recreates a fresh shell in the same startup directory (Ghostty semantics) —
 *  never the old PTY, scrollback, or a relaunched agent session. */
export type ClosedTerminalTabSnapshot = {
  startupCwd?: string
  shellOverride?: string
  customTitle?: string
  color?: string
  position?: RecentlyClosedTabPosition
}

export type RecentlyClosedTabKind = 'terminal' | 'browser' | 'editor' | 'conversation'

const MAX_RECENT_CLOSED_TERMINAL_TABS = 10
// Why: wider than the per-type stacks (10) so cross-type ordering survives a
// full per-type stack; kind entries whose snapshot aged out are skipped on pop.
const MAX_RECENT_CLOSED_TAB_KINDS = 30

// Why: the map params tolerate undefined because several test harnesses build
// partial stores (single-slice spreads) that lack this slice's state.
export function pushClosedTerminalTabSnapshot(
  map: Record<string, ClosedTerminalTabSnapshot[]> | undefined,
  worktreeId: string,
  snapshot: ClosedTerminalTabSnapshot
): Record<string, ClosedTerminalTabSnapshot[]> {
  return {
    ...map,
    [worktreeId]: [snapshot, ...(map?.[worktreeId] ?? [])].slice(0, MAX_RECENT_CLOSED_TERMINAL_TABS)
  }
}

export function pushRecentlyClosedTabKind(
  map: Record<string, RecentlyClosedTabKind[]> | undefined,
  worktreeId: string,
  kind: RecentlyClosedTabKind,
  count = 1
): Record<string, RecentlyClosedTabKind[]> {
  // Why: preserve the original reference on no-op pushes so unrelated
  // subscribers don't re-evaluate (mirrors the closeTab unread-map pattern).
  if (count <= 0) {
    return map ?? {}
  }
  // Why: close-all may contain thousands of editor tabs, but entries beyond
  // the retained history cap can never affect reopen ordering.
  const retainedCount = Math.min(count, MAX_RECENT_CLOSED_TAB_KINDS)
  return {
    ...map,
    [worktreeId]: [
      ...(Array(retainedCount).fill(kind) as RecentlyClosedTabKind[]),
      ...(map?.[worktreeId] ?? [])
    ].slice(0, MAX_RECENT_CLOSED_TAB_KINDS)
  }
}

export function remapClosedTerminalTabSnapshotCwds(
  snapshots: ClosedTerminalTabSnapshot[],
  oldWorktreePath: string,
  newWorktreePath: string
): ClosedTerminalTabSnapshot[] {
  return snapshots.map((snapshot) => {
    if (!snapshot.startupCwd) {
      return snapshot
    }
    const relative = relativePathInsideRoot(oldWorktreePath, snapshot.startupCwd)
    if (relative === null) {
      return snapshot
    }
    if (!relative) {
      return { ...snapshot, startupCwd: newWorktreePath }
    }
    const useBackslash =
      isWindowsAbsolutePathLike(newWorktreePath) && newWorktreePath.includes('\\')
    const separator = useBackslash ? '\\' : '/'
    const base = newWorktreePath.replace(/[\\/]+$/g, '')
    const suffix = useBackslash ? relative.replace(/\//g, '\\') : relative
    return { ...snapshot, startupCwd: `${base}${separator}${suffix}` }
  })
}

export type RecentlyClosedTabsSlice = {
  recentlyClosedConversationTabsByWorktree: Record<string, ClosedConversationTab[]>
  rememberClosedConversationTab: (reference: ClosedConversationTab) => void
  reopenClosedConversationTab: (worktreeId: string) => boolean
  /** Newest-first snapshots of user-closed terminal tabs, per worktree. */
  recentlyClosedTerminalTabsByWorktree: Record<string, ClosedTerminalTabSnapshot[]>
  /** Newest-first close order across the terminal/browser/editor reopen stacks
   *  so Cmd+Shift+T pops true cross-type MRU (Chrome/Ghostty semantics). */
  recentlyClosedTabKindsByWorktree: Record<string, RecentlyClosedTabKind[]>
  reopenClosedTerminalTab: (worktreeId: string) => boolean
  reopenClosedTab: (worktreeId: string) => boolean
}

export const createRecentlyClosedTabsSlice: StateCreator<
  AppState,
  [],
  [],
  RecentlyClosedTabsSlice
> = (set, get) => ({
  recentlyClosedConversationTabsByWorktree: {},
  rememberClosedConversationTab: (reference) =>
    set((state) => ({
      recentlyClosedConversationTabsByWorktree: {
        ...state.recentlyClosedConversationTabsByWorktree,
        [reference.workspaceId]: [
          reference,
          ...(state.recentlyClosedConversationTabsByWorktree[reference.workspaceId] ?? []).filter(
            (old) =>
              old.conversationId !== reference.conversationId ||
              JSON.stringify(old.target) !== JSON.stringify(reference.target)
          )
        ].slice(0, 10)
      },
      recentlyClosedTabKindsByWorktree: pushRecentlyClosedTabKind(
        state.recentlyClosedTabKindsByWorktree,
        reference.workspaceId,
        'conversation'
      )
    })),
  reopenClosedConversationTab: (worktreeId) => {
    const reference = get().recentlyClosedConversationTabsByWorktree[worktreeId]?.[0]
    if (!reference) {
      return false
    }
    set((state) => ({
      recentlyClosedConversationTabsByWorktree: {
        ...state.recentlyClosedConversationTabsByWorktree,
        [worktreeId]: (state.recentlyClosedConversationTabsByWorktree[worktreeId] ?? []).slice(1)
      }
    }))
    void (async () => {
      let lifetime: ReturnType<typeof captureConversationTabLifetime> | undefined
      try {
        lifetime = captureConversationTabLifetime(get, reference)
        await setConversationTabVisibility(reference, true, lifetime)
        lifetime.assertCurrent()
        await refreshConversationTabLayout(reference, lifetime)
        lifetime.assertCurrent()
        const tabId =
          resolveLocalTabIdForHostSessionTab({
            ...structuredAgentSessionFocusOwner(reference.target),
            worktreeId,
            hostTabId: reference.tabId
          }) ?? reference.tabId
        const restored = get().unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)
        if (
          !restored ||
          restored.contentType !== 'conversation' ||
          restored.entityId !== reference.conversationId ||
          structuredAgentSessionOwnerForTab(get(), restored) !==
            executionHostIdForStructuredTarget(reference.target)
        ) {
          throw new Error('Conversation reopen frame unavailable')
        }
        get().activateTab(restored.id, { worktreeId, preservePreview: true })
      } catch {
        if (lifetime?.canRetainReference()) {
          get().rememberClosedConversationTab(reference)
          reportConversationVisibilityFailure()
        }
      } finally {
        lifetime?.close()
      }
    })()
    return true
  },
  recentlyClosedTerminalTabsByWorktree: {},
  recentlyClosedTabKindsByWorktree: {},

  reopenClosedTerminalTab: (worktreeId) => {
    // Why: explicitly remote-owned worktrees own terminals through the host
    // session. A raw local createTab here would leave an
    // unbacked phantom tab that races the next host snapshot, so skip local
    // reopen for those worktrees — the cross-type dispatcher falls through to
    // browser/editor. Imported directly instead of via web-runtime-session to
    // avoid a store slice ↔ store-index import cycle. Remote terminal reopen is
    // deferred (see PR notes); local + SSH worktrees are the covered surface.
    const owner = runtimeEnvironmentIdForWorkspaceOwner(get(), { workspaceId: worktreeId })
    // Why: a twin's reopen would spawn a local shell for a tab that may have lived on the other host.
    if (owner.kind === 'ambiguous' || owner.environmentId?.trim()) {
      return false
    }
    // Why: read and pop atomically inside set() to prevent a TOCTOU race where
    // two rapid Cmd+Shift+T presses both restore the same entry (mirrors
    // reopenClosedBrowserTab).
    let snapshot: ClosedTerminalTabSnapshot | undefined
    set((s) => {
      const stack = s.recentlyClosedTerminalTabsByWorktree[worktreeId] ?? []
      snapshot = stack[0]
      if (!snapshot) {
        return s
      }
      return {
        recentlyClosedTerminalTabsByWorktree: {
          ...s.recentlyClosedTerminalTabsByWorktree,
          [worktreeId]: stack.slice(1)
        }
      }
    })
    if (!snapshot) {
      return false
    }

    const tab = get().createTab(worktreeId, snapshot.position?.groupId, snapshot.shellOverride, {
      ...(snapshot.startupCwd ? { startupCwd: snapshot.startupCwd } : {}),
      activate: true
    })
    if (snapshot.customTitle) {
      get().setTabCustomTitle(tab.id, snapshot.customTitle)
    }
    if (snapshot.color) {
      get().setTabColor(tab.id, snapshot.color)
    }
    get().setActiveTabType('terminal', worktreeId)
    restoreRecentlyClosedTabPosition(get, worktreeId, tab.id, snapshot.position)
    return true
  },

  reopenClosedTab: (worktreeId) => {
    // Why: a kind entry can outlive its snapshot (per-type caps are tighter,
    // and the browser stack dedupes by workspace id), so skip drained kinds
    // instead of giving up. Each iteration shifts one entry, so the loop is
    // bounded by the kind list length.
    for (;;) {
      let kind: RecentlyClosedTabKind | undefined
      set((s) => {
        const kinds = s.recentlyClosedTabKindsByWorktree[worktreeId] ?? []
        kind = kinds[0]
        if (!kind) {
          return s
        }
        return {
          recentlyClosedTabKindsByWorktree: {
            ...s.recentlyClosedTabKindsByWorktree,
            [worktreeId]: kinds.slice(1)
          }
        }
      })
      if (!kind) {
        return false
      }
      const reopened =
        kind === 'conversation'
          ? get().reopenClosedConversationTab(worktreeId)
          : kind === 'terminal'
            ? get().reopenClosedTerminalTab(worktreeId)
            : kind === 'browser'
              ? get().reopenClosedBrowserTab(worktreeId) !== null
              : get().reopenClosedEditorTab(worktreeId)
      if (reopened) {
        return true
      }
    }
  }
})
