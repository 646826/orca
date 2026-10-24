import { useRef, useState } from 'react'
import type { captureConversationReaderOwner } from '@/runtime/conversation-reader-owner'
import type { ConversationSurfaceSnapshot } from '../../../../shared/conversation-surface-rpc'
import {
  ConversationTransferRecoveryViewSchema,
  ConversationTransferRecoveryResultSchema,
  type ConversationTransferRecoveryView,
  type ConversationTransferIntentionCursor,
  type ConversationTransferIntention,
  type ConversationTransferRecoveryAction
} from '../../../../shared/conversation-transfer-recovery'
import { structuredSessionOperationId } from './structured-agent-session-operation-id'

export function useNativeChatTransferRecovery({
  snapshot,
  scopeKey,
  request,
  run
}: {
  snapshot: ConversationSurfaceSnapshot
  scopeKey: string
  request: ReturnType<typeof captureConversationReaderOwner>['request']
  run: (action: () => Promise<unknown>, refresh?: boolean) => Promise<void>
}) {
  const [page, setPage] = useState<{
    scope: string
    before: ConversationTransferIntentionCursor | null
    view: ConversationTransferRecoveryView
  } | null>(null)
  const currentScope = useRef(scopeKey)
  currentScope.current = scopeKey
  const transferRecovery = page?.scope === scopeKey ? page.view : snapshot.transferRecovery
  const recoverTransfer = (
    intention: ConversationTransferIntention,
    action: ConversationTransferRecoveryAction
  ) =>
    run(async () => {
      const current = transferRecovery?.intentions.find(
        (entry) => entry.transferId === intention.transferId
      )
      if (
        !current?.scope ||
        !current.actions.includes(action) ||
        current.scope.expectedProofDigest !== intention.scope?.expectedProofDigest
      ) {
        return
      }
      ConversationTransferRecoveryResultSchema.parse(
        await request('conversation.recoverTransfer', {
          ...current.scope,
          action,
          clientOperationId: structuredSessionOperationId()
        })
      )
    })
  const readOlderIntentions = () =>
    run(async () => {
      if (!snapshot.transferRecovery || !transferRecovery?.next) {
        return
      }
      const requestedScope = currentScope.current
      const view = ConversationTransferRecoveryViewSchema.parse(
        await request('conversation.transferIntentions', {
          conversationId: snapshot.conversation.conversationId,
          before: transferRecovery.next
        })
      )
      if (currentScope.current === requestedScope) {
        setPage({ scope: requestedScope, before: transferRecovery.next, view })
      }
    }, false)
  const reconcileTransferStatus = () =>
    run(async () => {
      if (!snapshot.transferRecovery) {
        return
      }
      const requestedScope = currentScope.current
      const before = page?.scope === requestedScope ? page.before : null
      const view = ConversationTransferRecoveryViewSchema.parse(
        await request('conversation.transferIntentions', {
          conversationId: snapshot.conversation.conversationId,
          before
        })
      )
      if (currentScope.current === requestedScope) {
        setPage({ scope: requestedScope, before, view })
      }
    }, false)
  return { transferRecovery, recoverTransfer, readOlderIntentions, reconcileTransferStatus }
}
