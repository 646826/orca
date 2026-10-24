import type { ConversationTabSurfaceSchema } from '../../../../shared/conversation-surface-rpc'
import type { z } from 'zod'
import type { NativeChatComposerDraftOwner } from './native-chat-composer-draft-storage'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'

type Surface = z.infer<typeof ConversationTabSurfaceSchema>
const owners = new Map<symbol, { scopeKey: string; owner: NativeChatComposerDraftOwner }>()
/** Promotion keeps the founding draft and in-flight upload callbacks in their original scope. */
export function conversationDraftScopeKey(surface: Pick<Surface, 'sourceSessionId'>): string {
  return structuredAgentSessionDraftScopeKey(surface.sourceSessionId)
}
export function registerConversationDraftOwner(surface: Surface): () => void {
  const key = Symbol(surface.conversationId)
  owners.set(key, {
    scopeKey: conversationDraftScopeKey(surface),
    owner: {
      workspaceId: surface.location.workspaceId,
      executionHostId: surface.location.executionHostId
    }
  })
  return () => {
    owners.delete(key)
  }
}
export function conversationDraftOwner(
  scopeKey: string
): NativeChatComposerDraftOwner | null | undefined {
  const matches = [...owners.values()].filter((entry) => entry.scopeKey === scopeKey)
  const first = matches[0]?.owner
  if (!first) {
    return undefined
  }
  return first &&
    matches.every(
      ({ owner }) =>
        owner.workspaceId === first.workspaceId && owner.executionHostId === first.executionHostId
    )
    ? first
    : null
}
