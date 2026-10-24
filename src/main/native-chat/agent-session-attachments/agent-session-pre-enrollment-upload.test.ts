import { expect, test } from 'vitest'
import { beginSwitch } from '../agent-session-wire/structured-conversation-switch.test-fixture'
import { hostTestState } from '../agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION } from '../agent-session-wire/structured-agent-session-host-test-data'
import { AgentSessionAttachmentStore } from './agent-session-attachment-store'
import { createAgentSessionUploadOwnership } from './agent-session-upload-provenance'
import { agentSessionAttachmentStoreRoot } from './agent-session-attachment-references'
import { claimAgentSessionAttachmentsInTransaction } from './agent-session-attachment-claims'

test('a real upload before enrollment can be sent by B only until its original context is cleared', async () => {
  let storedPath: string | null = null
  const { host, store, intent, targetId } = await beginSwitch(async () => {
    const state = hostTestState()
    const db = state.host.deps.journalDatabase.db
    const uploads = new AgentSessionAttachmentStore(
      agentSessionAttachmentStoreRoot(state.host.deps.journalDatabase.stateDirectory),
      {
        hasSession: (id) => state.store.getRecord(id) !== null,
        ownership: createAgentSessionUploadOwnership(() => db)
      }
    )
    const stored = await uploads.storeFile('before-enrollment.png', Buffer.from('image bytes'), {
      sessionId: HOST_TEST_SESSION
    })
    storedPath = stored
  })
  if (!storedPath) {
    throw new Error('missing uploaded fixture')
  }
  const path = storedPath
  const claim = () =>
    host.deps.journalDatabase.transaction((db) =>
      claimAgentSessionAttachmentsInTransaction(db, {
        sessionId: targetId,
        stateDirectory: host.deps.journalDatabase.stateDirectory,
        required: true,
        now: Date.now(),
        body: { kind: 'message', role: 'user', blocks: [{ type: 'image-ref', path }] }
      })
    )
  expect(claim).not.toThrow()
  const conversation = store.conversations.read(intent.conversationId)
  if (!conversation) {
    throw new Error('missing conversation')
  }
  // Simulate the persisted clear-generation boundary, without granting old upload authority.
  host.deps.journalDatabase.db
    .prepare('UPDATE conversations SET record_json=? WHERE conversation_id=?')
    .run(
      JSON.stringify({ ...conversation, contextGeneration: conversation.contextGeneration + 1 }),
      conversation.conversationId
    )
  expect(claim).toThrow()
})
