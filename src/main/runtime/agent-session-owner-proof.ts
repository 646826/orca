import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  prepareConversationPendingNativeIdentity,
  publishConversationPendingNativeIdentity
} from '../native-chat/conversations/conversation-pending-native-identity'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import { commitConversationAcquisitionOrigin } from '../native-chat/conversations/conversation-origin-admission'
import type { ConversationOrigin } from '../native-chat/conversations/conversation-origin'
import type { AgentSessionStoreTransactions } from './agent-session-store-transactions'
import { proveAgentSessionOwner } from './agent-session-lease-transitions'

export type AgentSessionOwnerProof = {
  sessionId: string
  fence: number
  link?: AgentSessionProviderHandleLink
  now: number
  leaseTtlMs?: number
  acquisitionGeneration?: string
  conversationOrigin?: ConversationOrigin
}
export function proveAgentSessionOwnerWithOrigin(
  transactions: AgentSessionStoreTransactions,
  args: AgentSessionOwnerProof,
  defaultLeaseTtlMs: number
) {
  const origin = args.conversationOrigin
  let previous: AgentSessionRecord | undefined
  let proved: AgentSessionRecord | undefined
  return transactions.transact(
    (draft) => {
      const record = draft.records.get(args.sessionId)
      if (!record) {
        throw draft.unreadableRecords.has(args.sessionId)
          ? agentSessionRefusalError('execution_owner_reconciling', { reason: 'recordUnreadable' })
          : agentSessionRefusalError('agent_session_identity_required', { reason: 'recordMissing' })
      }
      previous = record
      const next = proveAgentSessionOwner({
        ...args,
        record,
        leaseTtlMs: args.leaseTtlMs ?? defaultLeaseTtlMs
      })
      proved = next
      draft.records.set(args.sessionId, next)
      return next
    },
    {
      inTransaction: origin
        ? (db) => {
            if (!previous || !proved) {
              throw new Error('missing owner proof draft')
            }
            prepareConversationPendingNativeIdentity(db, {
              before: previous,
              origin,
              acquisitionGeneration: args.acquisitionGeneration
            })
            commitConversationAcquisitionOrigin(db, {
              sessionId: args.sessionId,
              fence: args.fence,
              origin
            })
            if (args.link) {
              publishConversationPendingNativeIdentity(db, {
                before: { ...previous, lease: proved.lease },
                after: proved,
                link: args.link,
                acquisitionGeneration: args.acquisitionGeneration
              })
            }
          }
        : undefined
    }
  )
}
