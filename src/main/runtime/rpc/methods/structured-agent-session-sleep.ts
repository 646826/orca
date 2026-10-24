import { defineMethod } from '../core'
import { requireConversationMutationCapability } from './conversation-gate'
import {
  requireStructuredCapability,
  requireInstalledStructuredHost as requireInstalledHost
} from './structured-agent-session-gate'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredSessionNeverStarted } from '../../agent-session-record-founding'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { SleepWorkspaceParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_SLEEP_METHODS = [
  defineMethod({
    name: 'agentSession.sleepWorkspace',
    permission: 'workspace',
    params: SleepWorkspaceParams,
    handler: async (params, ctx) => {
      requireStructuredCapability(ctx)
      if (params.markAsleep) {
        const host = await requireInstalledHost(ctx)
        const selected = host.deps.store
          .listRecords()
          .filter(
            (record) =>
              record.location.workspaceId === params.workspaceId &&
              record.location.executionHostId === LOCAL_EXECUTION_HOST_ID
          )
        for (const record of selected) {
          requireConversationMutationCapability(ctx, host, record.sessionId)
        }
        return host.sleepWorkspace(params.workspaceId, true, (sessionId) =>
          requireConversationMutationCapability(ctx, host, sessionId)
        )
      }
      const installed = getStructuredAgentSessionHost()
      if (installed) {
        return installed.sleepWorkspace(params.workspaceId, params.markAsleep)
      }
      let store: Awaited<ReturnType<typeof ctx.runtime.openAgentSessionRecordStore>>
      try {
        store = await ctx.runtime.openAgentSessionRecordStore()
      } catch (error) {
        const appeared = getStructuredAgentSessionHost()
        if (appeared) {
          return appeared.sleepWorkspace(params.workspaceId, params.markAsleep)
        }
        console.warn('[agent-session] workspace sleep record inventory unavailable', error)
        return { stoppedSessionIds: [], failures: [{ reason: 'inventory-unavailable' }] }
      }
      const appeared = getStructuredAgentSessionHost()
      if (appeared) {
        return appeared.sleepWorkspace(params.workspaceId, params.markAsleep)
      }
      try {
        const records = store
          .listRecords()
          .filter(
            (record) =>
              record.location.workspaceId === params.workspaceId &&
              record.location.executionHostId === LOCAL_EXECUTION_HOST_ID
          )
        const stoppedSessionIds = records
          .filter(structuredSessionNeverStarted)
          .map((record) => record.sessionId)
        const failures = records
          .filter((record) => !structuredSessionNeverStarted(record))
          .map((record) => ({ sessionId: record.sessionId, reason: 'stop-unverifiable' as const }))
        return failures.length > 0 ? { stoppedSessionIds, failures } : { stoppedSessionIds }
      } catch (error) {
        console.warn('[agent-session] workspace sleep record inventory failed', error)
        return { stoppedSessionIds: [], failures: [{ reason: 'inventory-unavailable' }] }
      }
    }
  })
]
