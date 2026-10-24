import type { ConversationAttachmentVersion } from '../agent-session-attachments/conversation-attachment-claims'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { createConversationTablesSql } from './conversation-schema'
import { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import { ensureAgentSessionAttachmentClaimTables } from '../agent-session-attachments/agent-session-attachment-claims'
import {
  ensureConversationAttachmentClaimTables,
  verifyConversationAttachment
} from '../agent-session-attachments/conversation-attachment-claims'
import { retrieveConversationArtifact } from './conversation-artifact-disclosure'

let db: Database.Database
let root: string
let store: AgentSessionAttachmentStore
let path: string
const conversation = {
  conversationId: 'chat',
  location: {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'folder',
    workspaceKind: 'folder'
  },
  revision: 1,
  contextGeneration: 1,
  activationFence: 1,
  activeSegmentId: 'segment',
  pendingOperationKey: null
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-disclosure-'))
  db = new Database(':memory:')
  db.exec(createConversationTablesSql())
  ensureAgentSessionAttachmentClaimTables(db)
  ensureConversationAttachmentClaimTables(db)
  db.prepare('INSERT INTO conversations VALUES (?,?)').run('chat', JSON.stringify(conversation))
  db.prepare('INSERT INTO conversation_segments VALUES (?,?,?,?)').run(
    'segment',
    'chat',
    1,
    JSON.stringify({
      segmentId: 'segment',
      conversationId: 'chat',
      ordinal: 1,
      sessionId: 'session',
      contextGeneration: 1,
      activationFence: 1,
      nativeBindingGeneration: 1,
      startSequence: 1,
      boundary: { sessionId: 'session', epoch: 'epoch', endSequence: 1 }
    })
  )
  store = new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(root), {
    hasSession: () => true
  })
  path = await store.storeFile('evidence.txt', Buffer.from('available canonical evidence'))
  const version = await verifyConversationAttachment({ stateDirectory: root, path })
  db.prepare('INSERT INTO conversation_attachment_claims VALUES(?,?,?,?,?,?)').run(
    'conversation-source:segment',
    version.uploadId,
    version.name,
    version.sha256,
    version.byteLength,
    1
  )
})
afterEach(async () => {
  db.close()
  await rm(root, { recursive: true, force: true })
})
const request = () => ({
  db,
  stateDirectory: root,
  store,
  conversationId: 'chat',
  contextGeneration: 1,
  segmentId: 'segment',
  path,
  decision: 'include' as const,
  disclosure: {
    targetBindingDigest: 'a'.repeat(64),
    resolve: (version: ConversationAttachmentVersion) => ({
      version,
      conversationId: 'chat',
      contextGeneration: 1,
      targetBindingDigest: 'a'.repeat(64),
      action: 'include' as const
    })
  }
})
it('retrieves retained bytes after source-session claims are gone and creates an independent claim', async () => {
  const result = await retrieveConversationArtifact(request())
  expect(await readFile(result.path, 'utf8')).toBe('available canonical evidence')
  expect(result.path).not.toBe(path)
  expect(
    db.prepare('SELECT 1 FROM conversation_attachment_claims WHERE owner_id=?').get(result.ownerId)
  ).toBeDefined()
})
it('refuses another conversation or old generation before publishing bytes', async () => {
  await expect(
    retrieveConversationArtifact({ ...request(), conversationId: 'other' })
  ).rejects.toMatchObject({ code: 'scope' })
  await expect(
    retrieveConversationArtifact({ ...request(), contextGeneration: 2 })
  ).rejects.toMatchObject({ code: 'scope' })
})
it('refuses explicit exclusion and unclaimed paths', async () => {
  await expect(
    retrieveConversationArtifact({ ...request(), decision: 'exclude' })
  ).rejects.toMatchObject({ code: 'excluded' })
  const unclaimed = await store.storeFile('private.txt', Buffer.from('private'))
  await expect(
    retrieveConversationArtifact({ ...request(), path: unclaimed })
  ).rejects.toMatchObject({ code: 'scope' })
})
it('distinguishes missing and changed bytes, never treating a stored digest as recovery', async () => {
  await writeFile(path, 'changed')
  await expect(retrieveConversationArtifact(request())).rejects.toMatchObject({ code: 'changed' })
  await rm(path)
  await expect(retrieveConversationArtifact(request())).rejects.toMatchObject({ code: 'missing' })
})
it('rejects a symlink and aborted retrieval without claiming a published artifact', async () => {
  const external = join(root, 'external.txt')
  await writeFile(external, 'available canonical evidence')
  await rm(path)
  await symlink(external, path)
  await expect(retrieveConversationArtifact(request())).rejects.toMatchObject({ code: 'scope' })
  const controller = new AbortController()
  controller.abort()
  await expect(
    retrieveConversationArtifact({ ...request(), signal: controller.signal })
  ).rejects.toThrow()
  expect(db.prepare('SELECT count(*) n FROM conversation_attachment_claims').get()?.n).toBe(1)
})
it('rechecks generation after snapshot intake and never commits a stale disclosure claim', async () => {
  const original = store.importFreshFile.bind(store)
  store.importFreshFile = async (...args) => {
    const result = await original(...args)
    db.prepare('UPDATE conversations SET record_json=?').run(
      JSON.stringify({ ...conversation, contextGeneration: 2 })
    )
    return result
  }
  await expect(retrieveConversationArtifact(request())).rejects.toMatchObject({ code: 'scope' })
  expect(db.prepare('SELECT count(*) n FROM conversation_attachment_claims').get()?.n).toBe(1)
})
it('requires host target-bound disclosure before reading a retained artifact', async () => {
  await expect(
    retrieveConversationArtifact({ ...request(), disclosure: undefined })
  ).rejects.toMatchObject({ code: 'scope' })
})
it('enforces host exclusion before reading missing bytes despite caller inclusion', async () => {
  const input = request()
  await rm(path)
  await expect(
    retrieveConversationArtifact({
      ...input,
      disclosure: {
        ...input.disclosure,
        resolve: (version) => ({ ...input.disclosure.resolve(version), action: 'exclude' })
      }
    })
  ).rejects.toMatchObject({ code: 'excluded' })
  expect(db.prepare('SELECT COUNT(*) n FROM conversation_attachment_claims').get()?.n).toBe(1)
})
it('captures snapshot scope before awaiting bytes', async () => {
  const input = request()
  const pending = retrieveConversationArtifact(input)
  input.contextGeneration = 2
  input.conversationId = 'other'
  const result = await pending
  expect(result.ownerId).toMatch(/^conversation-export:chat:1:/)
})
