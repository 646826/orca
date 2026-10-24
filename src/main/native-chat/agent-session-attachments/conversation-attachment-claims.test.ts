import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import {
  markUnclaimedUploadForSweep,
  pruneAgentSessionAttachmentClaims
} from './agent-session-attachment-claims'
import { agentSessionAttachmentStoreRoot } from './agent-session-attachment-references'
import {
  claimConversationAttachmentInTransaction,
  releaseConversationAttachmentClaims,
  verifyConversationAttachment
} from './conversation-attachment-claims'

const UPLOAD = '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01'

describe('conversation attachment retention', () => {
  let directory: string
  let root: string
  let path: string
  let host: JournalHostDatabase

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-conversation-attachment-'))
    root = agentSessionAttachmentStoreRoot(directory)
    path = join(root, UPLOAD, 'evidence.txt')
    await mkdir(join(root, UPLOAD), { recursive: true })
    await writeFile(path, 'original evidence')
    host = JournalHostDatabase.open(directory)
    host.db
      .prepare(
        'INSERT INTO agent_session_attachment_claims (upload_id, session_id, claimed_at) VALUES (?, ?, ?)'
      )
      .run(UPLOAD, 'source-session', 1)
  })

  afterEach(async () => {
    host.close()
    await rm(directory, { recursive: true, force: true })
  })

  async function pin(ownerId = 'manifest-1') {
    const attachment = await verifyConversationAttachment({ stateDirectory: directory, path })
    host.transaction((db) =>
      claimConversationAttachmentInTransaction(db, {
        ownerId,
        sourceSessionId: 'source-session',
        attachment,
        now: 2
      })
    )
    return attachment
  }

  it('keeps independent owners after session pruning and releases only the final owner', async () => {
    await pin()
    await pin('archive-1')
    host.close()
    host = JournalHostDatabase.open(directory)
    pruneAgentSessionAttachmentClaims(host.db, { root, recordedSessionIds: new Set() })
    expect(markUnclaimedUploadForSweep(host.db, UPLOAD, 3)).toBe(false)
    host.transaction((db) => releaseConversationAttachmentClaims(db, 'manifest-1'))
    expect(markUnclaimedUploadForSweep(host.db, UPLOAD, 4)).toBe(false)
    host.transaction((db) => releaseConversationAttachmentClaims(db, 'archive-1'))
    expect(markUnclaimedUploadForSweep(host.db, UPLOAD, 5)).toBe(true)
  })

  it('fences stale sweep SQL even after the source session claim is gone', async () => {
    await pin()
    host.db.exec('DELETE FROM agent_session_attachment_claims')
    expect(() =>
      host.db
        .prepare(
          'INSERT INTO agent_session_attachment_sweeps (upload_id, started_at) VALUES (?, ?)'
        )
        .run(UPLOAD, 3)
    ).toThrow(/retained/)
  })

  it('replays the same retained owner after source pruning without granting a new owner', async () => {
    const attachment = await pin()
    pruneAgentSessionAttachmentClaims(host.db, { root, recordedSessionIds: new Set() })
    expect(() =>
      host.transaction((db) =>
        claimConversationAttachmentInTransaction(db, {
          ownerId: 'manifest-1',
          sourceSessionId: 'source-session',
          attachment,
          now: 4
        })
      )
    ).not.toThrow()
    expect(() =>
      host.transaction((db) =>
        claimConversationAttachmentInTransaction(db, {
          ownerId: 'new-manifest',
          sourceSessionId: 'source-session',
          attachment,
          now: 4
        })
      )
    ).toThrow(/unavailable/)
  })

  it.each(['.', '..', 'bad\u0000name'])('rejects invalid retained filename %j', async (name) => {
    const attachment = await verifyConversationAttachment({ stateDirectory: directory, path })
    expect(() =>
      host.transaction((db) =>
        claimConversationAttachmentInTransaction(db, {
          ownerId: 'manifest-1',
          sourceSessionId: 'source-session',
          attachment: { ...attachment, name },
          now: 4
        })
      )
    ).toThrow(/unavailable/)
    expect(host.db.prepare('SELECT 1 FROM conversation_attachment_claims').all()).toEqual([])
  })

  it('refuses claiming after sweep admission or without source ownership', async () => {
    const attachment = await verifyConversationAttachment({ stateDirectory: directory, path })
    host.db.exec('DELETE FROM agent_session_attachment_claims')
    expect(markUnclaimedUploadForSweep(host.db, UPLOAD, 3)).toBe(true)
    expect(() =>
      host.transaction((db) =>
        claimConversationAttachmentInTransaction(db, {
          ownerId: 'manifest-1',
          sourceSessionId: 'source-session',
          attachment,
          now: 4
        })
      )
    ).toThrow(/unavailable/)
    expect(host.db.prepare('SELECT 1 FROM conversation_attachment_claims').all()).toEqual([])
  })

  it('rolls a claim back with its failed manifest transaction', async () => {
    const attachment = await verifyConversationAttachment({ stateDirectory: directory, path })
    expect(() =>
      host.transaction((db) => {
        claimConversationAttachmentInTransaction(db, {
          ownerId: 'manifest-1',
          sourceSessionId: 'source-session',
          attachment,
          now: 4
        })
        throw new Error('manifest failed')
      })
    ).toThrow('manifest failed')
    expect(host.db.prepare('SELECT 1 FROM conversation_attachment_claims').all()).toEqual([])
  })

  it('requires source ownership and refuses to replace an owner immutable version', async () => {
    const attachment = await pin()
    expect(() =>
      host.transaction((db) =>
        claimConversationAttachmentInTransaction(db, {
          ownerId: 'manifest-1',
          sourceSessionId: 'source-session',
          attachment: { ...attachment, sha256: 'a'.repeat(64) },
          now: 4
        })
      )
    ).toThrow(/changed/)
    expect(() =>
      host.transaction((db) =>
        claimConversationAttachmentInTransaction(db, {
          ownerId: 'other',
          sourceSessionId: 'other-session',
          attachment,
          now: 4
        })
      )
    ).toThrow(/unavailable/)
    expect(() =>
      claimConversationAttachmentInTransaction(host.db, {
        ownerId: 'outside-transaction',
        sourceSessionId: 'source-session',
        attachment,
        now: 4
      })
    ).toThrow(/transaction/)
  })

  it('detects changed or missing bytes without treating a digest as recovery', async () => {
    const expected = await pin()
    await writeFile(path, 'replaced evidence')
    await expect(
      verifyConversationAttachment({ stateDirectory: directory, path, expected })
    ).rejects.toMatchObject({ code: 'changed' })
    await rm(path)
    await expect(
      verifyConversationAttachment({ stateDirectory: directory, path, expected })
    ).rejects.toMatchObject({ code: 'missing' })
  })

  it('rejects a workspace path and a symlinked upload directory', async () => {
    const outside = join(directory, 'workspace')
    await mkdir(outside)
    await writeFile(join(outside, 'evidence.txt'), 'private')
    await expect(
      verifyConversationAttachment({
        stateDirectory: directory,
        path: join(outside, 'evidence.txt')
      })
    ).rejects.toMatchObject({ code: 'scope' })
    await rm(join(root, UPLOAD), { recursive: true })
    await symlink(outside, join(root, UPLOAD), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(
      verifyConversationAttachment({ stateDirectory: directory, path })
    ).rejects.toMatchObject({ code: 'scope' })
  })

  it('rejects a symlinked file and honors cancellation', async () => {
    const outside = join(directory, 'outside.txt')
    await writeFile(outside, 'private')
    await rm(path)
    await symlink(outside, path)
    await expect(
      verifyConversationAttachment({ stateDirectory: directory, path })
    ).rejects.toMatchObject({ code: 'scope' })
    const abort = new AbortController()
    abort.abort()
    await expect(
      verifyConversationAttachment({ stateDirectory: directory, path, signal: abort.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
