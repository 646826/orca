import { useContext, useMemo, type ReactNode } from 'react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NativeChatVisualOwnerContext } from './native-chat-visual-owner'
import { NativeChatMarkdownImageOwnerContext } from './native-chat-markdown-image-owner'

export function NativeChatHistoricalOwner({
  source,
  children
}: {
  source: NonNullable<NativeChatMessage['conversationSource']>
  children: ReactNode
}) {
  const visual = useContext(NativeChatVisualOwnerContext)
  const markdown = useContext(NativeChatMarkdownImageOwnerContext)
  const visualOwner = useMemo(
    () => (visual ? { ...visual, sessionId: source.sessionId } : null),
    [visual, source.sessionId]
  )
  const markdownOwner = useMemo(
    () => (markdown ? { ...markdown, sessionId: source.sessionId } : null),
    [markdown, source.sessionId]
  )
  return (
    <NativeChatVisualOwnerContext.Provider value={visualOwner}>
      <NativeChatMarkdownImageOwnerContext.Provider value={markdownOwner}>
        {children}
      </NativeChatMarkdownImageOwnerContext.Provider>
    </NativeChatVisualOwnerContext.Provider>
  )
}
