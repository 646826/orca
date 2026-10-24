import { isAgentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'

/** Storage bookkeeping can fail, but an admission refusal must never retire the tab. */
export async function hideStructuredSessionTab(
  host: StructuredAgentSessionHost | null,
  tab: { sessionId: string },
  assertAgentSessionMutation?: (sessionId: string) => void
): Promise<void> {
  if (typeof host?.setSessionTabVisibility !== 'function') {
    return
  }
  try {
    await (assertAgentSessionMutation
      ? host.setSessionTabVisibility(tab.sessionId, false, undefined, {
          assertMutationSupported: () => assertAgentSessionMutation(tab.sessionId)
        })
      : host.setSessionTabVisibility(tab.sessionId, false))
  } catch (error) {
    if (isAgentSessionRefusalError(error)) {
      throw error
    }
    host.deps.logger.warn('recording a closed chat tab failed', {
      scope: 'tab-visibility-close',
      sessionId: tab.sessionId,
      error
    })
  }
}
