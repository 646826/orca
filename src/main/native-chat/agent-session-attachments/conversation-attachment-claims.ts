import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isDefinitiveAbsence } from '../../../shared/definitive-filesystem-absence'
import type Database from '../../sqlite/sync-database'
import {
  agentSessionAttachmentStoreRoot,
  isAgentSessionAttachmentUploadId,
  parseAgentSessionAttachmentStorePath
} from './agent-session-attachment-references'

export type ConversationAttachmentVersion = {
  uploadId: string
  name: string
  sha256: string
  byteLength: number
}

export class ConversationAttachmentError extends Error {
  constructor(readonly code: 'scope' | 'missing' | 'changed' | 'unavailable') {
    super(`Conversation attachment ${code}`)
    this.name = 'ConversationAttachmentError'
  }
}

export function ensureConversationAttachmentClaimTables(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS conversation_attachment_claims (
  owner_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, upload_id, name)
);
CREATE INDEX IF NOT EXISTS conversation_attachment_upload_claims
ON conversation_attachment_claims (upload_id);
CREATE TRIGGER IF NOT EXISTS conversation_attachment_sweep_guard
BEFORE INSERT ON agent_session_attachment_sweeps
WHEN EXISTS (SELECT 1 FROM conversation_attachment_claims WHERE upload_id = NEW.upload_id)
BEGIN
  SELECT RAISE(ABORT, 'attachment is retained by a conversation');
END;
`)
}

function requireTransaction(db: Database.Database): void {
  if (!db.isTransaction) {
    throw new Error('Conversation attachment claims require a host transaction')
  }
}

export function claimConversationAttachmentInTransaction(
  db: Database.Database,
  input: {
    ownerId: string
    sourceSessionId: string
    attachment: ConversationAttachmentVersion
    now: number
  }
): void {
  requireTransaction(db)
  const { ownerId, sourceSessionId, attachment, now } = input
  if (
    ownerId.length === 0 ||
    !isAgentSessionAttachmentUploadId(attachment.uploadId) ||
    attachment.name.length === 0 ||
    attachment.name === '.' ||
    attachment.name === '..' ||
    attachment.name.includes('\0') ||
    basename(attachment.name) !== attachment.name ||
    /[\\/]/.test(attachment.name) ||
    !/^[a-f0-9]{64}$/.test(attachment.sha256) ||
    !Number.isSafeInteger(attachment.byteLength) ||
    attachment.byteLength < 0
  ) {
    throw new ConversationAttachmentError('unavailable')
  }
  if (
    db
      .prepare('SELECT 1 FROM agent_session_attachment_sweeps WHERE upload_id = ?')
      .get(attachment.uploadId)
  ) {
    throw new ConversationAttachmentError('unavailable')
  }
  const existing = db
    .prepare(
      'SELECT sha256, byte_length FROM conversation_attachment_claims WHERE owner_id = ? AND upload_id = ? AND name = ?'
    )
    .get(ownerId, attachment.uploadId, attachment.name)
  if (
    existing &&
    (existing.sha256 !== attachment.sha256 || existing.byte_length !== attachment.byteLength)
  ) {
    throw new ConversationAttachmentError('changed')
  }
  if (existing) {
    return
  }
  const sourceClaim = db
    .prepare('SELECT 1 FROM agent_session_attachment_claims WHERE upload_id = ? AND session_id = ?')
    .get(attachment.uploadId, sourceSessionId)
  if (!sourceClaim) {
    throw new ConversationAttachmentError('unavailable')
  }
  db.prepare(
    `INSERT OR IGNORE INTO conversation_attachment_claims
      (owner_id, upload_id, name, sha256, byte_length, claimed_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    ownerId,
    attachment.uploadId,
    attachment.name,
    attachment.sha256,
    attachment.byteLength,
    now
  )
}

export function releaseConversationAttachmentClaims(db: Database.Database, ownerId: string): void {
  requireTransaction(db)
  db.prepare('DELETE FROM conversation_attachment_claims WHERE owner_id = ?').run(ownerId)
}

/** Detects external mutation of app-managed write-once uploads; a digest cannot restore bytes. */
export async function verifyConversationAttachment(input: {
  stateDirectory: string
  path: string
  expected?: ConversationAttachmentVersion
  signal?: AbortSignal
  /** Digests are provisional until this promise verifies the full immutable version. */
  indexChunkDigest?: (chunk: { sha256: Buffer; offset: number; length: number }) => void
}): Promise<ConversationAttachmentVersion> {
  input.signal?.throwIfAborted()
  const root = agentSessionAttachmentStoreRoot(input.stateDirectory)
  const parsed = parseAgentSessionAttachmentStorePath(root, input.path)
  if (!parsed) {
    throw new ConversationAttachmentError('scope')
  }
  try {
    const uploadDirectory = join(root, parsed.uploadId)
    const [rootStat, directoryStat, fileStat] = await Promise.all([
      lstat(root),
      lstat(uploadDirectory),
      lstat(input.path)
    ])
    if (!rootStat.isDirectory() || !directoryStat.isDirectory() || !fileStat.isFile()) {
      throw new ConversationAttachmentError('scope')
    }
    const canonicalRoot = await realpath(root)
    const canonicalDirectory = join(canonicalRoot, parsed.uploadId)
    const canonicalFile = join(canonicalDirectory, parsed.name)
    if (
      (await realpath(uploadDirectory)) !== canonicalDirectory ||
      (await realpath(input.path)) !== canonicalFile
    ) {
      throw new ConversationAttachmentError('scope')
    }
    const handle = await open(
      canonicalFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    )
    try {
      const before = await handle.stat()
      if (
        !before.isFile() ||
        !Number.isSafeInteger(before.size) ||
        before.dev !== fileStat.dev ||
        before.ino !== fileStat.ino
      ) {
        throw new ConversationAttachmentError('changed')
      }
      const hash = createHash('sha256')
      let byteLength = 0
      const pending = input.indexChunkDigest ? Buffer.alloc(64 * 1024) : null
      let used = 0,
        indexed = 0
      const emitDigest = () => {
        if (pending && used) {
          input.indexChunkDigest?.({
            sha256: createHash('sha256').update(pending.subarray(0, used)).digest(),
            offset: indexed,
            length: used
          })
          indexed += used
          used = 0
        }
      }
      if (before.size > 0) {
        for await (const chunk of handle.createReadStream({
          start: 0,
          end: before.size - 1,
          autoClose: false,
          highWaterMark: 64 * 1024,
          signal: input.signal
        })) {
          if (!Buffer.isBuffer(chunk)) {
            throw new ConversationAttachmentError('changed')
          }
          hash.update(chunk)
          if (pending) {
            let offset = 0
            while (offset < chunk.length) {
              const take = Math.min(pending.length - used, chunk.length - offset)
              chunk.copy(pending, used, offset, offset + take)
              used += take
              offset += take
              if (used === pending.length) {
                emitDigest()
              }
            }
          }
          byteLength += chunk.length
        }
      }
      emitDigest()
      const after = await handle.stat()
      const pathAfter = await lstat(input.path)
      if (
        !pathAfter.isFile() ||
        (await realpath(uploadDirectory)) !== canonicalDirectory ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        byteLength !== before.size ||
        pathAfter.ino !== before.ino ||
        pathAfter.dev !== before.dev
      ) {
        throw new ConversationAttachmentError('changed')
      }
      const result = { ...parsed, sha256: hash.digest('hex'), byteLength }
      const expected = input.expected
      if (
        expected &&
        (expected.uploadId !== result.uploadId ||
          expected.name !== result.name ||
          expected.sha256 !== result.sha256 ||
          expected.byteLength !== result.byteLength)
      ) {
        throw new ConversationAttachmentError('changed')
      }
      return result
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      throw new ConversationAttachmentError('missing')
    }
    throw error
  }
}
