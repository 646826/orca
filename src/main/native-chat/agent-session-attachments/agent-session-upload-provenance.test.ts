import { expect, it } from 'vitest'
import { beginSwitch } from '../agent-session-wire/structured-conversation-switch.test-fixture'
import { HOST_TEST_SESSION } from '../agent-session-wire/structured-agent-session-host-test-data'
import {
  createAgentSessionUploadOwnership,
  assertConversationUploadOwner
} from './agent-session-upload-provenance'
it('requires committed owner and admits transfer only in the same current conversation generation', async () => {
  const { host, store, intent, targetId } = await beginSwitch()
  const db = host.deps.journalDatabase.db
  const ownership = createAgentSessionUploadOwnership(() => db)
  const owner = ownership.capture(HOST_TEST_SESSION)
  ownership.begin({ uploadId: 'owned', name: 'draft.txt', byteLength: 3, owner })
  expect(() =>
    assertConversationUploadOwner(db, { uploadId: 'owned', targetSessionId: targetId })
  ).toThrow()
  ownership.commit('owned', owner)
  expect(() =>
    assertConversationUploadOwner(db, { uploadId: 'owned', targetSessionId: targetId })
  ).not.toThrow()
  expect(() =>
    assertConversationUploadOwner(db, { uploadId: 'unowned', targetSessionId: targetId })
  ).toThrow()
  const conversation = store.conversations.read(intent.conversationId)!
  db.prepare('UPDATE conversations SET record_json=? WHERE conversation_id=?').run(
    JSON.stringify({ ...conversation, contextGeneration: 2 }),
    conversation.conversationId
  )
  expect(() =>
    assertConversationUploadOwner(db, { uploadId: 'owned', targetSessionId: targetId })
  ).toThrow()
})
it('refuses commit after native clear and never grants foreign record scope', async () => {
  const { host, targetId } = await beginSwitch()
  const db = host.deps.journalDatabase.db
  const ownership = createAgentSessionUploadOwnership(() => db)
  const owner = ownership.capture(HOST_TEST_SESSION)
  ownership.begin({ uploadId: 'pending', name: 'draft.txt', byteLength: 3, owner })
  db.prepare(
    "UPDATE agent_session_records SET record_json=json_set(record_json,'$.providerContextBoundary',json(?)) WHERE session_id=?"
  ).run(JSON.stringify({ operationId: 'clear', afterFence: 1, clearedAt: 1 }), HOST_TEST_SESSION)
  expect(() => ownership.commit('pending', owner)).toThrow()
  expect(() =>
    assertConversationUploadOwner(db, { uploadId: 'pending', targetSessionId: targetId })
  ).toThrow()
})
it('actual upload retains immutable owner through start, bytes, commit and same-conversation send', async () => {
  const { AgentSessionAttachmentStore } = await import('./agent-session-attachment-store')
  const { agentSessionAttachmentStoreRoot } = await import('./agent-session-attachment-references')
  const { host, store, targetId } = await beginSwitch()
  const db = host.deps.journalDatabase.db
  const uploads = new AgentSessionAttachmentStore(
    agentSessionAttachmentStoreRoot(host.deps.journalDatabase.stateDirectory),
    {
      hasSession: (id) => store.getRecord(id) !== null,
      ownership: createAgentSessionUploadOwnership(() => db)
    }
  )
  const { uploadId } = await uploads.startUpload({
    callerKey: 'owner',
    sessionId: HOST_TEST_SESSION,
    name: 'draft.txt',
    byteLength: 3
  })
  await uploads.appendChunk({
    callerKey: 'owner',
    uploadId,
    offset: 0,
    contentBase64: Buffer.from('abc').toString('base64')
  })
  await uploads.commitUpload({ callerKey: 'owner', uploadId })
  expect(() =>
    assertConversationUploadOwner(db, { uploadId, targetSessionId: targetId })
  ).not.toThrow()
  await expect(uploads.storeFile('unbound.txt', Buffer.from('no'))).rejects.toThrow()
})
it('rejects a foreign workspace even if a corrupted participant points at the same aggregate', async () => {
  const { host, targetId } = await beginSwitch()
  const db = host.deps.journalDatabase.db
  const ownership = createAgentSessionUploadOwnership(() => db)
  const owner = ownership.capture(HOST_TEST_SESSION)
  ownership.begin({ uploadId: 'foreign-test', name: 'draft.txt', byteLength: 3, owner })
  ownership.commit('foreign-test', owner)
  db.prepare(
    "UPDATE agent_session_records SET record_json=json_set(record_json,'$.location.workspaceId','foreign') WHERE session_id=?"
  ).run(targetId)
  expect(() =>
    assertConversationUploadOwner(db, { uploadId: 'foreign-test', targetSessionId: targetId })
  ).toThrow()
})
