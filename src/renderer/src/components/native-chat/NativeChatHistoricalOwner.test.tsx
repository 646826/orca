// @vitest-environment happy-dom
import { useContext } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { NativeChatHistoricalOwner } from './NativeChatHistoricalOwner'
import {
  NativeChatVisualOwnerContext,
  type NativeChatVisualOwner
} from './native-chat-visual-owner'
import { NativeChatMarkdownImageOwnerContext } from './native-chat-markdown-image-owner'
const source = {
  sessionId: 'original',
  segmentId: 'segment',
  epoch: 'epoch',
  itemId: 'item',
  revision: 1
}
afterEach(cleanup)
function Probe() {
  const visual = useContext(NativeChatVisualOwnerContext)
  const markdown = useContext(NativeChatMarkdownImageOwnerContext)
  return <output>{JSON.stringify({ visual, markdown })}</output>
}
const visual: NativeChatVisualOwner = {
  target: { kind: 'environment', environmentId: 'paired' },
  sessionId: 'active',
  worktreeId: 'folder'
}
const markdown = {
  fileLinkContext: null,
  runtimeContext: null,
  isVisible: true,
  sessionId: 'active'
}
it('reads historical media from the original session on the same authoritative host', () => {
  render(
    <NativeChatVisualOwnerContext.Provider value={visual}>
      <NativeChatMarkdownImageOwnerContext.Provider value={markdown}>
        <NativeChatHistoricalOwner source={source}>
          <Probe />
        </NativeChatHistoricalOwner>
      </NativeChatMarkdownImageOwnerContext.Provider>
    </NativeChatVisualOwnerContext.Provider>
  )
  expect(JSON.parse(screen.getByRole('status').textContent ?? '{}')).toEqual({
    visual: {
      target: { kind: 'environment', environmentId: 'paired' },
      sessionId: 'original',
      worktreeId: 'folder'
    },
    markdown: {
      fileLinkContext: null,
      runtimeContext: null,
      isVisible: true,
      sessionId: 'original'
    }
  })
})
it('does not invent a local owner when the host owner is unavailable', () => {
  render(
    <NativeChatHistoricalOwner source={source}>
      <Probe />
    </NativeChatHistoricalOwner>
  )
  expect(screen.getByRole('status').textContent).toBe('{"visual":null,"markdown":null}')
})
