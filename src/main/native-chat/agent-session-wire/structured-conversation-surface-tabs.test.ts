import { expect, it } from 'vitest'
import { beginSwitch } from './structured-conversation-switch.test-fixture'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
it('does not republish acquired participants as native tabs once a visible or hidden conversation owns the surface', async () => {
  const { host, store, intent, targetId } = await beginSwitch()
  await store.setSessionTabVisibility(HOST_TEST_SESSION, true, 'visual-conversation')
  const conversation = store.conversations.read(intent.conversationId)!
  expect(host.listSessionTabs().some((tab) => tab.sessionId === HOST_TEST_SESSION)).toBe(true)
  await store.conversations.surfaces.promote(
    {
      conversationId: conversation.conversationId,
      sourceSessionId: HOST_TEST_SESSION,
      expectedTabId: 'visual-conversation',
      expectedRevision: conversation.revision
    },
    () => undefined
  )
  expect(
    host.listSessionTabs().filter((tab) => [HOST_TEST_SESSION, targetId].includes(tab.sessionId))
  ).toEqual([])
  await store.conversations.surfaces.setVisibility(
    { conversationId: conversation.conversationId, expectedSurfaceRevision: 1, visible: false },
    () => undefined
  )
  expect(
    host.listSessionTabs().filter((tab) => [HOST_TEST_SESSION, targetId].includes(tab.sessionId))
  ).toEqual([])
  expect(host.collaboratorsForTests().sessions.has(HOST_TEST_SESSION)).toBe(true)
})
