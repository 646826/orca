import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

/**
 * Chat-tab visibility is the deletion funnel: every path that removes a chat as a user-facing
 * artifact — a closed tab, the close RPC, worker settlement, worktree removal — retires the
 * durable tab here, so the chat's restart offer and any failure record die with it. Advisory:
 * recovery bookkeeping must never gate closing a chat.
 */
export function setStructuredAgentSessionTabVisibility(
  host: {
    deps: {
      logger: StructuredAgentSessionLogger
      store: {
        setSessionTabVisibility: (
          sessionId: string,
          visible: boolean,
          tabId?: string,
          assertMutationSupported?: () => void
        ) => Promise<void>
      }
      onSessionTabHidden?: (sessionId: string) => void
    }
    restartResume: {
      dismiss: (
        sessionIds: readonly string[],
        audience?: undefined,
        assertMutationSupported?: (sessionId: string) => void
      ) => Promise<number>
    }
  },
  sessionId: string,
  visible: boolean,
  tabId?: string,
  assertMutationSupported?: () => void
): Promise<void> {
  assertMutationSupported?.()
  if (!visible) {
    const dismissed = assertMutationSupported
      ? host.restartResume.dismiss([sessionId], undefined, assertMutationSupported)
      : host.restartResume.dismiss([sessionId])
    void dismissed.catch(() => {
      host.deps.logger.warn('forgetting recovery records on chat close failed', {
        scope: 'tab-close-recovery-dismiss',
        sessionId
      })
    })
  }
  return host.deps.store.setSessionTabVisibility(sessionId, visible, tabId, assertMutationSupported)
}

export type StructuredAgentSessionTab = {
  sessionId: string
  workspaceId: string
  agent: AgentSessionRecord['provider']
}

export function listStructuredAgentSessionTabs(
  sessions: ReadonlyMap<
    string,
    { params: { location: { workspaceId: string }; provider: AgentSessionRecord['provider'] } }
  >
): StructuredAgentSessionTab[] {
  return [...sessions.entries()].map(([sessionId, session]) => ({
    sessionId,
    workspaceId: session.params.location.workspaceId,
    agent: session.params.provider
  }))
}

type TabSessions = ReadonlyMap<
  string,
  {
    child?: unknown
    params: { location: { workspaceId: string }; provider: AgentSessionRecord['provider'] }
  }
>

/** The host's chat-tab surface; reads `host.deps` per call, so it sees the host's wrapped deps. */
export function createStructuredAgentSessionTabSurface(
  host: Parameters<typeof setStructuredAgentSessionTabVisibility>[0] & {
    deps: {
      store: Pick<
        AgentSessionRecordStore,
        | 'getVisibleSessionTabIndex'
        | 'getSessionTabId'
        | 'showSessionTabs'
        | 'getRecord'
        | 'conversations'
      >
    }
  },
  sessions: TabSessions,
  forgetStatus: (sessionId: string) => void
) {
  // Restored chats that could not be opened. Each keeps its tab, whose read says why.
  const unopened = new Set<string>()
  return {
    listConversationSurfaces: (
      scope: Parameters<AgentSessionRecordStore['conversations']['surfaces']['list']>[0]
    ) => host.deps.store.conversations.surfaces.list(scope),
    listSessionTabs: (): StructuredAgentSessionTab[] =>
      [
        ...listStructuredAgentSessionTabs(sessions),
        ...[...unopened].flatMap((sessionId) => {
          const record = sessions.has(sessionId) ? null : host.deps.store.getRecord(sessionId)
          return record
            ? [{ sessionId, workspaceId: record.location.workspaceId, agent: record.provider }]
            : []
        })
      ].filter((tab) => {
        const member = host.deps.store.conversations.membership(tab.sessionId)
        return !member || !host.deps.store.conversations.surfaces.read(member.conversationId)
      }),
    /** A restore target with a record whose open failed. */
    markUnopened: (sessionId: string): void => {
      unopened.add(sessionId)
    },
    getPersistedVisibleSessionTabIndex: () => host.deps.store.getVisibleSessionTabIndex(),
    getSessionTabId: (sessionId: string): string | null =>
      host.deps.store.getSessionTabId(sessionId),
    showSessionTabs: (sessionIds: readonly string[]) => host.deps.store.showSessionTabs(sessionIds),
    notifySessionTabHidden: (sessionId: string): void => notifyTabHidden(host, sessionId),
    setSessionTabVisibility: async (
      sessionId: string,
      visible: boolean,
      tabId?: string,
      /** A close that may still put the tab back sends the hidden notice once it settles. */
      options?: { deferHiddenNotice?: boolean; assertMutationSupported?: () => void }
    ): Promise<void> => {
      await setStructuredAgentSessionTabVisibility(
        host,
        sessionId,
        visible,
        tabId,
        options?.assertMutationSupported
      )
      if (!visible) {
        unopened.delete(sessionId)
        if (!options?.deferHiddenNotice) {
          notifyTabHidden(host, sessionId)
        }
      }
      // The tab edge of the row's lifetime; the handle close is the other.
      if (!visible && !sessions.get(sessionId)?.child) {
        forgetStatus(sessionId)
      }
    }
  }
}

function notifyTabHidden(
  host: Parameters<typeof setStructuredAgentSessionTabVisibility>[0],
  sessionId: string
): void {
  try {
    host.deps.onSessionTabHidden?.(sessionId)
  } catch (error) {
    // Bookkeeping never gates closing a chat.
    host.deps.logger.warn('a chat tab close listener failed', {
      scope: 'tab-hidden-listener',
      sessionId,
      error
    })
  }
}
