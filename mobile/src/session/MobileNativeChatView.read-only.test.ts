import { expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { MobileNativeChatView } from './MobileNativeChatView'
import { installChatViewHooks, hostType } from './MobileNativeChatView.harness.test-fixture'
vi.mock('react-native', async () => {
  const { reactNativeStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return reactNativeStub()
})
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('react-native-gesture-handler', async () => {
  const { gestureHandlerStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return gestureHandlerStub()
})
vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  ChevronsDownUp: 'ChevronsDownUp',
  ChevronsUpDown: 'ChevronsUpDown',
  Square: 'Square'
}))
vi.mock('./MobileNativeChatMessage', () => ({ MobileNativeChatMessage: 'ChatMessage' }))
vi.mock('./MobileNativeChatLiveLine', () => ({ MobileNativeChatLiveLine: 'LiveStatus' }))
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./MobileNativeChatPermission', () => ({ MobileNativeChatPermission: 'ChatPermission' }))
vi.mock('./MobileNativeChatQuestion', () => ({ MobileNativeChatQuestion: 'ChatQuestion' }))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('./MobileNativeChatComposer', async () => {
  const { composerStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return composerStub()
})

installChatViewHooks()
it('renders historical rows without composer, live prompt cards or native action callbacks', async () => {
  const message = {
    id: 'history',
    role: 'assistant' as const,
    source: 'transcript' as const,
    timestamp: 0,
    blocks: [{ type: 'text' as const, text: 'Retained history' }]
  }
  let renderer: ReturnType<typeof create> | undefined
  await act(async () => {
    renderer = create(
      createElement(MobileNativeChatView, {
        readOnly: true,
        messages: [message],
        folded: [message],
        status: 'ready',
        streaming: null,
        pending: [],
        sendSurfaceId: 'conversation'
      })
    )
  })
  expect(renderer?.root.find((node) => hostType(node) === 'FlatList').props.data).toMatchObject([
    { id: 'history' }
  ])
  expect(renderer?.root.findAll((node) => hostType(node) === 'Composer')).toHaveLength(0)
  expect(renderer?.root.findAll((node) => hostType(node) === 'ChatPermission')).toHaveLength(0)
  await act(async () => renderer?.unmount())
})
