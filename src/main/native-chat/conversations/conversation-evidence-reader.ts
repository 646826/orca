import type {
  ConversationEvidenceVersion,
  ConversationEvidenceGap,
  ConversationCoverageRepresentation
} from '../../../shared/conversation-handoff'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type Database from '../../sqlite/sync-database'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import {
  assertConversationEvidenceScope,
  type ConversationEvidenceHost
} from './conversation-evidence-scope'
import { assertConversationManifestPartAuthority } from './conversation-context-authority'
import { readConversationManifestParts } from './conversation-context-parts'
import { readConversationExportProof } from './conversation-context-export-proof'
import { conversationContextDigest } from './conversation-context-consent'
import {
  openConversationEvidenceChunks,
  type ConversationEvidenceChunks
} from './conversation-evidence-chunks'
import { ConversationExportError } from './conversation-export-error'

/** Host construction only. Native tools receive locators, never database handles or paths. */
export function openConversationEvidenceReader(
  input: {
    db: Database.Database
    stateDirectory: string
    planId: string
    host: ConversationEvidenceHost
    acquisitionGeneration: string
  },
  signal: AbortSignal
) {
  const { db, stateDirectory, planId, host, acquisitionGeneration } = input
  let operationSignal: AbortSignal | null = null
  let readingOrdinal: number | null = null
  let closed = false,
    busy = false
  let cached: { key: string; lease: ConversationEvidenceChunks } | null = null
  const check = () => {
    signal.throwIfAborted()
    operationSignal?.throwIfAborted()
    if (closed) {
      throw new ConversationExportError('scope')
    }
    return assertConversationEvidenceScope(db, planId, host, acquisitionGeneration)
  }
  const { manifest } = check()
  const scopeKey = manifest.evidenceIndex?.rootDigest ?? manifest.digest
  const count = manifest.evidenceIndex?.partCount ?? manifest.projection.length
  const encode = (ordinal: number, offset: number) =>
    Buffer.from(JSON.stringify([scopeKey, ordinal, offset])).toString('base64url')
  const decode = (value: string) => {
    if (typeof value !== 'string' || value.length > 256) {
      throw new ConversationExportError('scope')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    } catch {
      throw new ConversationExportError('scope')
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      parsed[0] !== scopeKey ||
      typeof parsed[1] !== 'number' ||
      !Number.isSafeInteger(parsed[1]) ||
      typeof parsed[2] !== 'number' ||
      !Number.isSafeInteger(parsed[2]) ||
      parsed[1] < 1 ||
      parsed[1] > count ||
      parsed[2] < 0
    ) {
      throw new ConversationExportError('scope')
    }
    return { ordinal: parsed[1], offset: parsed[2] }
  }
  const partAt = (ordinal: number) => {
    check()
    const index = manifest.evidenceIndex
    if (index) {
      const stored = db
        .prepare(
          `SELECT i.root_digest,i.part_count,c.manifest_id FROM conversation_manifest_part_indexes i JOIN conversation_manifest_compilations c ON c.index_id=i.index_id AND c.root_digest=i.root_digest WHERE i.index_id=?`
        )
        .get(index.indexId)
      if (
        stored?.root_digest !== index.rootDigest ||
        stored.part_count !== index.partCount ||
        stored.manifest_id !== manifest.manifestId
      ) {
        throw new ConversationExportError('scope')
      }
      const row = readConversationManifestParts(db, index.indexId, ordinal - 1, 1)[0]
      if (!row || row.ordinal !== ordinal) {
        throw new ConversationExportError('missing-source')
      }
      return row
    }
    const part = manifest.projection[ordinal - 1]
    if (!part) {
      throw new ConversationExportError('scope')
    }
    return {
      ordinal,
      part,
      gaps: manifest.gaps.filter(
        (g) =>
          conversationContextDigest(g.source) === conversationContextDigest(part.version.source)
      )
    }
  }
  const authorize = (ordinal: number) => {
    const row = partAt(ordinal)
    assertConversationManifestPartAuthority(db, manifest, row.part)
    if (
      row.part.representation === 'missing' ||
      !row.part.artifactId ||
      !host.canRetrieve(manifest, row.part)
    ) {
      throw new ConversationExportError('excluded')
    }
    const proof = readConversationExportProof(db, {
      ownerId: row.part.artifactId,
      conversationId: manifest.conversationId,
      contextGeneration: manifest.contextGeneration,
      version: row.part.version
    })
    if (!proof) {
      throw new ConversationExportError('missing-source')
    }
    return { ...row, proof }
  }
  return {
    list(after?: string) {
      check()
      const start = after ? decode(after).ordinal : 0
      const sources: {
        locator: string
        version: ConversationEvidenceVersion
        representation: ConversationCoverageRepresentation
        gaps: ConversationEvidenceGap[]
      }[] = []
      let responseBytes = 1024
      for (let ordinal = start + 1; ordinal <= Math.min(count, start + 32); ordinal++) {
        const row = partAt(ordinal)
        assertConversationManifestPartAuthority(db, manifest, row.part)
        const descriptor = {
          locator: encode(ordinal, 0),
          version: row.part.version,
          representation: row.part.representation,
          gaps: row.gaps
        }
        const bytes = Buffer.byteLength(JSON.stringify(descriptor))
        if (responseBytes + bytes > 65536) {
          if (sources.length === 0) {
            throw new ConversationExportError('resource-limit')
          }
          break
        }
        responseBytes += bytes
        sources.push(descriptor)
      }
      check()
      const last = start + sources.length
      return { sources, nextCursor: last < count ? encode(last, 0) : null }
    },
    async read(
      request: { source: string; cursor?: string; maxBytes?: number },
      requestSignal: AbortSignal = signal
    ) {
      check()
      if (busy) {
        throw new ConversationExportError('resource-limit')
      }
      const source = decode(request.source)
      const cursor = request.cursor ? decode(request.cursor) : source
      if (source.offset !== 0 || cursor.ordinal !== source.ordinal) {
        throw new ConversationExportError('scope')
      }
      const limit = request.maxBytes ?? 65536
      if (!Number.isSafeInteger(limit) || limit < 4 || limit > 65536) {
        throw new ConversationExportError('resource-limit')
      }
      busy = true
      operationSignal = requestSignal
      readingOrdinal = source.ordinal
      try {
        check()
        const { part, proof, gaps } = authorize(source.ordinal)
        if (cursor.offset > proof.byteLength) {
          throw new ConversationExportError('scope')
        }
        const key = conversationContextDigest(proof.artifactVersion)
        if (cached?.key !== key) {
          await cached?.lease.close()
          cached = null
          const lease = await openConversationEvidenceChunks({
            stateDirectory,
            path: join(
              agentSessionAttachmentStoreRoot(stateDirectory),
              proof.artifactVersion.uploadId,
              proof.artifactVersion.name
            ),
            version: proof.artifactVersion,
            signal,
            assertAuthorized: () => {
              check()
              if (readingOrdinal === null) {
                throw new ConversationExportError('scope')
              }
              authorize(readingOrdinal)
            }
          })
          try {
            check()
            cached = { key, lease }
          } catch (error) {
            await lease.close()
            throw error
          }
        }
        const length = Math.min(limit, 32768, proof.byteLength - cursor.offset)
        const bytes = await cached.lease.read(proof.byteOffset + cursor.offset, length)
        const current = authorize(source.ordinal)
        if (conversationContextDigest(current.proof) !== conversationContextDigest(proof)) {
          throw new ConversationExportError('scope')
        }
        let text: string
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, {
            stream: cursor.offset + length < proof.byteLength
          })
        } catch {
          throw new ConversationExportError('corrupt-source')
        }
        const delivered = Buffer.byteLength(text)
        if (length > 0 && delivered === 0) {
          throw new ConversationExportError('corrupt-source')
        }
        check()
        const offset = cursor.offset + delivered
        const response = {
          version: part.version,
          text,
          byteOffset: cursor.offset,
          byteLength: proof.byteLength,
          sha256: createHash('sha256').update(text).digest('hex'),
          gaps,
          nextCursor: offset < proof.byteLength ? encode(source.ordinal, offset) : null
        }
        if (Buffer.byteLength(JSON.stringify(response)) > 65536) {
          throw new ConversationExportError('resource-limit')
        }
        return response
      } finally {
        busy = false
        operationSignal = null
        readingOrdinal = null
      }
    },
    async close() {
      closed = true
      await cached?.lease.close()
      cached = null
    }
  }
}
