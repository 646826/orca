import { readConversationExportProof } from './conversation-context-export-proof'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { verifyConversationAttachment } from '../agent-session-attachments/conversation-attachment-claims'
import {
  assertConversationExportScope,
  ConversationExportError,
  type ConversationExportScope,
  type ConversationExportArtifact
} from './conversation-artifact-disclosure'
import type { ConversationEvidenceVersion } from '../../../shared/conversation-handoff'
import type { ConversationExportedRow } from './conversation-context-export'

export async function* streamConversationExportRows(
  input: ConversationExportScope & {
    artifact: ConversationExportArtifact
    rows: readonly ConversationExportedRow[]
  }
): AsyncGenerator<{
  version: ConversationEvidenceVersion
  byteLength: number
  artifactId: string
  chunks: AsyncIterable<Uint8Array>
}> {
  if (input.rows.length > 256) {
    throw new ConversationExportError('resource-limit')
  }
  input = { ...input, artifact: structuredClone(input.artifact), rows: structuredClone(input.rows) }
  const { artifact } = input
  const recheck = (): void => {
    assertConversationExportScope(input)
    if (
      !artifact.ownerId.startsWith(
        `conversation-export:${input.conversationId}:${input.contextGeneration}:`
      )
    ) {
      throw new ConversationExportError('scope')
    }
    const claim = input.db
      .prepare(
        'SELECT sha256,byte_length FROM conversation_attachment_claims WHERE owner_id=? AND upload_id=? AND name=?'
      )
      .get(artifact.ownerId, artifact.version.uploadId, artifact.version.name)
    if (
      claim?.sha256 !== artifact.version.sha256 ||
      claim?.byte_length !== artifact.version.byteLength
    ) {
      throw new ConversationExportError('scope')
    }
  }
  const assertProof = (entry: ConversationExportedRow): void => {
    recheck()
    const proof = readConversationExportProof(input.db, {
      ownerId: artifact.ownerId,
      conversationId: input.conversationId,
      contextGeneration: input.contextGeneration,
      version: entry.version
    })
    if (
      !proof ||
      proof.frameOffset !== entry.frameOffset ||
      proof.byteOffset !== entry.byteOffset ||
      proof.byteLength !== entry.byteLength ||
      proof.artifactVersion.uploadId !== artifact.version.uploadId ||
      proof.artifactVersion.name !== artifact.version.name ||
      proof.artifactVersion.sha256 !== artifact.version.sha256 ||
      proof.artifactVersion.byteLength !== artifact.version.byteLength
    ) {
      throw new ConversationExportError('scope')
    }
  }
  recheck()
  await verifyConversationAttachment({
    stateDirectory: input.stateDirectory,
    path: artifact.path,
    expected: artifact.version,
    signal: input.signal
  })
  for (const entry of input.rows) {
    assertProof(entry)
    if (
      !Number.isSafeInteger(entry.frameOffset) ||
      entry.frameOffset < 0 ||
      entry.frameOffset >= entry.byteOffset ||
      !Number.isSafeInteger(entry.byteOffset) ||
      !Number.isSafeInteger(entry.byteLength) ||
      entry.byteOffset < 0 ||
      entry.byteLength < 1 ||
      entry.byteOffset + entry.byteLength > artifact.version.byteLength
    ) {
      throw new ConversationExportError('scope')
    }
    const chunks = async function* (): AsyncGenerator<Uint8Array> {
      assertProof(entry)
      const handle = await open(
        artifact.path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
      )
      try {
        const before = await handle.stat()
        if (!before.isFile() || before.size !== artifact.version.byteLength) {
          throw new ConversationExportError('corrupt-source')
        }
        const expectedHeader = Buffer.from(
          `${JSON.stringify({ format: 'orca-canonical-row-v1', source: entry.version.source, byteLength: entry.byteLength })}\n`
        )
        if (
          expectedHeader.length > 64 * 1024 ||
          entry.byteOffset - entry.frameOffset !== expectedHeader.length
        ) {
          throw new ConversationExportError('scope')
        }
        const header = Buffer.alloc(expectedHeader.length)
        let headerOffset = 0
        while (headerOffset < header.length) {
          const { bytesRead } = await handle.read(
            header,
            headerOffset,
            header.length - headerOffset,
            entry.frameOffset + headerOffset
          )
          if (bytesRead === 0) {
            throw new ConversationExportError('corrupt-source')
          }
          headerOffset += bytesRead
        }
        if (!header.equals(expectedHeader)) {
          throw new ConversationExportError('scope')
        }
        const hash = createHash('sha256')
        let position = 0
        while (position < entry.byteLength) {
          assertProof(entry)
          const buffer = Buffer.alloc(Math.min(64 * 1024, entry.byteLength - position))
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.length,
            entry.byteOffset + position
          )
          if (bytesRead === 0) {
            throw new ConversationExportError('missing-source')
          }
          const bytes = buffer.subarray(0, bytesRead)
          hash.update(bytes)
          position += bytesRead
          yield bytes
        }
        const after = await handle.stat()
        assertProof(entry)
        if (
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs ||
          hash.digest('hex') !== entry.version.sha256
        ) {
          throw new ConversationExportError('corrupt-source')
        }
      } finally {
        await handle.close()
      }
    }
    yield {
      version: entry.version,
      byteLength: entry.byteLength,
      artifactId: artifact.ownerId,
      chunks: chunks()
    }
  }
}
