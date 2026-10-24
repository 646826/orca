import { expect, test, vi } from 'vitest'
import {
  attach,
  hostTestState
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { conversationAgentDisplay } from './conversation-surface-read'

test('echoing desired permission options does not prove native enforcement', async () => {
  await attach()
  const { host, store } = hostTestState()
  const record = store.getRecord(HOST_TEST_SESSION)!
  vi.spyOn(store, 'getRecord').mockReturnValue({ ...record, permissionMode: 'ask' })
  host.deps.adapter.projectOptions = (_sessionId, desired) => ({ options: desired, models: [] })
  expect(conversationAgentDisplay(host, HOST_TEST_SESSION).permissions).toEqual({
    selected: 'ask',
    applied: null,
    state: 'unverified'
  })
})
