import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import type { AgentSessionStoreTransactions } from './agent-session-store-transactions'
import { recordAgentSessionProviderHandle } from './agent-session-provider-handle-transition'
import {
  publishConversationPendingNativeIdentity,
  assertConversationPendingNativePublished
} from '../native-chat/conversations/conversation-pending-native-identity'
export function publishAgentSessionProviderHandle(
  transactions: AgentSessionStoreTransactions,
  input: {
    sessionId: string
    fence: number
    acquisitionGeneration: string
    link?: AgentSessionProviderHandleLink
    now: number
  }
): Promise<AgentSessionRecord> {
  let before: AgentSessionRecord | undefined
  let after: AgentSessionRecord | undefined
  return transactions.transact(
    (draft) => {
      before = draft.records.get(input.sessionId)
      if (!before) {
        throw new Error('missing provider handle record')
      }
      if (
        before.lease.runtimeFence !== input.fence ||
        before.lease.claimStatus !== 'live' ||
        (input.link && input.link.mintedAtFence !== input.fence)
      ) {
        throw new Error('provider publication ownership changed')
      }
      after =
        !input.link ||
        (before.providerHandleChain.length === 1 &&
          JSON.stringify(before.providerHandleChain[0]) === JSON.stringify(input.link))
          ? before
          : recordAgentSessionProviderHandle({ ...input, link: input.link, record: before })
      draft.records.set(input.sessionId, after)
      return after
    },
    {
      inTransaction: (db) => {
        if (!before || !after) {
          throw new Error('missing provider publication draft')
        }
        if (input.link) {
          publishConversationPendingNativeIdentity(db, {
            before,
            after,
            link: input.link,
            acquisitionGeneration: input.acquisitionGeneration
          })
        }
        assertConversationPendingNativePublished(db, input)
      }
    }
  )
}
