import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it } from 'vitest'
import { mobileConversationFixture } from './mobile-conversation.test-fixture'
import { useMobileConversation } from './use-mobile-conversation'
import type { MobileConversationClient } from './mobile-conversation-reader'

it('never renders the previous host surface under a new owner before effects or late replies', async () => {
  const first = mobileConversationFixture(),
    second = mobileConversationFixture()
  second.snapshot.active.agentLabel = 'Different host'
  let release: (() => void) | undefined
  const original = second.client.sendRequest
  second.client.sendRequest = async (...args) => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return original(...args)
  }
  const rendered: Array<{ host: string; label: string | null }> = []
  function Harness({ host, client }: { host: string; client: MobileConversationClient }) {
    const state = useMobileConversation(client, host, 'w', 'c')
    rendered.push({ host, label: state.surface?.active.agentLabel ?? null })
    return null
  }
  let renderer: ReturnType<typeof create> | undefined
  await act(async () => {
    renderer = create(createElement(Harness, { host: 'one', client: first.client }))
  })
  expect(rendered.at(-1)).toEqual({ host: 'one', label: 'Claude' })
  await act(async () => {
    renderer?.update(createElement(Harness, { host: 'two', client: second.client }))
  })
  expect(rendered.filter((row) => row.host === 'two').every((row) => row.label === null)).toBe(true)
  await act(async () => {
    first.event({
      type: 'changed',
      state: { conversationId: 'c', revision: 2, contextGeneration: 1, activationFence: 1 }
    })
  })
  expect(rendered.at(-1)).toEqual({ host: 'two', label: null })
  await act(async () => {
    renderer?.unmount()
    release?.()
  })
})

it('rebinds read-only history after the same logical client changes generation', async () => {
  const f = mobileConversationFixture()
  let current: ReturnType<typeof useMobileConversation> | undefined
  function Harness() {
    current = useMobileConversation(f.client, 'host', 'w', 'c')
    return null
  }
  let renderer: ReturnType<typeof create> | undefined
  await act(async () => {
    renderer = create(createElement(Harness))
  })
  expect(current?.surface?.active.agentLabel).toBe('Claude')
  f.snapshot.active.agentLabel = 'Reconnected'
  await act(async () => {
    f.replace()
  })
  expect(current?.surface?.active.agentLabel).toBe('Reconnected')
  expect(
    f.send.mock.calls.filter(([method]) => method === 'conversation.surfaceRead')
  ).toHaveLength(2)
  await act(async () => renderer?.unmount())
})
