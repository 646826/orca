import { ConversationExportError } from './conversation-export-error'
import {
  assertConversationArtifactDisclosure,
  type ConversationArtifactDisclosure
} from './conversation-artifact-access'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type Database from '../../sqlite/sync-database'
import type { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import {
  agentSessionAttachmentStoreRoot,
  parseAgentSessionAttachmentStorePath
} from '../agent-session-attachments/agent-session-attachment-references'
import {
  verifyConversationAttachment,
  type ConversationAttachmentVersion
} from '../agent-session-attachments/conversation-attachment-claims'
import { runJournalTransaction } from '../agent-session-journal/journal-transaction'
import { readConversation, readSegments } from './conversation-read-model'

export { ConversationExportError } from './conversation-export-error'
export type ConversationExportScope = {
  db: Database.Database
  stateDirectory: string
  store: AgentSessionAttachmentStore
  conversationId: string
  contextGeneration: number
  signal?: AbortSignal
}
export type ConversationExportArtifact = {
  ownerId: string
  path: string
  version: ConversationAttachmentVersion
}
export function assertConversationExportScope(
  input: ConversationExportScope,
  segmentId?: string
): void {
  input.signal?.throwIfAborted()
  const conversation = readConversation(input.db, input.conversationId)
  if (
    !conversation ||
    conversation.contextGeneration !== input.contextGeneration ||
    (segmentId !== undefined &&
      !readSegments(input.db, input.conversationId).some(
        (segment) =>
          segment.segmentId === segmentId && segment.contextGeneration === input.contextGeneration
      )) ||
    input.store.rootDir !== agentSessionAttachmentStoreRoot(input.stateDirectory)
  ) {
    throw new ConversationExportError('scope')
  }
}
/** Only a caller-created private snapshot may enter trusted attachment intake. */
export async function publishConversationSnapshot(
  input: ConversationExportScope & {
    snapshotPath: string
    name: string
    byteLength: number
    sha256: string
    recheck: () => void
    commit?: (artifact: ConversationExportArtifact) => void
  }
): Promise<ConversationExportArtifact> {
  assertConversationExportScope(input)
  input.recheck()
  const path = await input.store.importFreshFile(input.name, input.snapshotPath, input.byteLength)
  try {
    const version = await verifyConversationAttachment({
      stateDirectory: input.stateDirectory,
      path,
      signal: input.signal
    })
    if (version.sha256 !== input.sha256 || version.byteLength !== input.byteLength) {
      throw new ConversationExportError('corrupt-source')
    }
    const ownerId = `conversation-export:${input.conversationId}:${input.contextGeneration}:${randomUUID()}`
    runJournalTransaction(input.db, () => {
      assertConversationExportScope(input)
      input.recheck()
      if (
        input.db
          .prepare('SELECT 1 FROM agent_session_attachment_sweeps WHERE upload_id=?')
          .get(version.uploadId)
      ) {
        throw new ConversationExportError('missing-source')
      }
      input.db
        .prepare(
          'INSERT INTO conversation_attachment_claims(owner_id,upload_id,name,sha256,byte_length,claimed_at) VALUES(?,?,?,?,?,?)'
        )
        .run(
          ownerId,
          version.uploadId,
          version.name,
          version.sha256,
          version.byteLength,
          Date.now()
        )
      input.commit?.({ ownerId, path, version })
    })
    return { ownerId, path, version }
  } catch (error) {
    // This random upload has not been returned or claimed by any other operation.
    await rm(path, { force: true }).catch(() => {})
    throw error
  }
}

/** Host-local preparation snapshot only; native access additionally requires manifest/receipt authorization. */
export async function retrieveConversationArtifact(
  input: ConversationExportScope & {
    segmentId: string
    path: string
    decision: 'include' | 'exclude'
    disclosure?: ConversationArtifactDisclosure
  }
): Promise<ConversationExportArtifact> {
  input = { ...input, disclosure: input.disclosure ? { ...input.disclosure } : undefined }
  assertConversationExportScope(input, input.segmentId)
  if (input.decision !== 'include') {
    throw new ConversationExportError('excluded')
  }
  const parsed = parseAgentSessionAttachmentStorePath(input.store.rootDir, input.path)
  if (!parsed) {
    throw new ConversationExportError('scope')
  }
  const ownerId = `conversation-source:${input.segmentId}`
  const claim = input.db
    .prepare(
      'SELECT sha256,byte_length FROM conversation_attachment_claims WHERE owner_id=? AND upload_id=? AND name=?'
    )
    .get(ownerId, parsed.uploadId, parsed.name)
  if (typeof claim?.sha256 !== 'string' || typeof claim.byte_length !== 'number') {
    throw new ConversationExportError('scope')
  }
  const expected = { ...parsed, sha256: claim.sha256, byteLength: claim.byte_length }
  const frozenTarget = input.disclosure?.targetBindingDigest
  assertConversationArtifactDisclosure(input, expected, frozenTarget)
  const recheck = (): void => {
    assertConversationArtifactDisclosure(input, expected, frozenTarget)
    assertConversationExportScope(input, input.segmentId)
    const current = input.db
      .prepare(
        'SELECT sha256,byte_length FROM conversation_attachment_claims WHERE owner_id=? AND upload_id=? AND name=?'
      )
      .get(ownerId, parsed.uploadId, parsed.name)
    if (current?.sha256 !== expected.sha256 || current?.byte_length !== expected.byteLength) {
      throw new ConversationExportError('scope')
    }
  }
  await verifyConversationAttachment({
    stateDirectory: input.stateDirectory,
    path: input.path,
    expected,
    signal: input.signal
  })
  const temporary = await mkdtemp(join(input.stateDirectory, '.conversation-export-'))
  const snapshotPath = join(temporary, 'snapshot')
  try {
    const source = await open(
      input.path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    )
    try {
      const destination = await open(snapshotPath, 'wx', 0o600)
      try {
        const buffer = Buffer.alloc(64 * 1024)
        let position = 0
        while (position < expected.byteLength) {
          recheck()
          const { bytesRead } = await source.read(
            buffer,
            0,
            Math.min(buffer.length, expected.byteLength - position),
            position
          )
          if (bytesRead === 0) {
            throw new ConversationExportError('missing-source')
          }
          let offset = 0
          while (offset < bytesRead) {
            const { bytesWritten } = await destination.write(buffer, offset, bytesRead - offset)
            if (bytesWritten === 0) {
              throw new ConversationExportError('corrupt-source')
            }
            offset += bytesWritten
          }
          position += bytesRead
        }
        await destination.sync()
      } finally {
        await destination.close()
      }
    } finally {
      await source.close()
    }
    await verifyConversationAttachment({
      stateDirectory: input.stateDirectory,
      path: input.path,
      expected,
      signal: input.signal
    })
    return await publishConversationSnapshot({
      ...input,
      snapshotPath,
      name: expected.name,
      byteLength: expected.byteLength,
      sha256: expected.sha256,
      recheck
    })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
