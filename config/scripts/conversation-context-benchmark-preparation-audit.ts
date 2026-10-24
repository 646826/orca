import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { setImmediate as yieldLoop } from 'node:timers/promises'
import type Database from '../../src/main/sqlite/sync-database'
import type {
  ConversationContextManifest,
  ConversationContextRepresentation
} from '../../src/shared/conversation-handoff'
import { readConversationManifestParts } from '../../src/main/native-chat/conversations/conversation-context-parts'
import { conversationEvidenceKey } from '../../src/main/native-chat/conversations/conversation-context-evidence'
import { parseJournalRow } from '../../src/main/native-chat/agent-session-journal/journal-row-schema'
import { readConversationExportProof } from '../../src/main/native-chat/conversations/conversation-context-export-proof'
import { streamConversationExportRows } from '../../src/main/native-chat/conversations/conversation-context-export-reader'
import type { ConversationExportScope } from '../../src/main/native-chat/conversations/conversation-artifact-disclosure'
import { agentSessionAttachmentStoreRoot } from '../../src/main/native-chat/agent-session-attachments/agent-session-attachment-references'
import { createConversationContextRowValidator } from '../../src/main/native-chat/conversations/conversation-context-row-validation'

export function auditPreparationBenchmarkPart(
  raw: string,
  part: ConversationContextRepresentation,
  projection: 'exact' | 'tools' = 'exact'
) {
  if (createHash('sha256').update(raw).digest('hex') !== part.version.sha256) {
    throw new Error('Canonical integrity mismatch')
  }
  if (part.representation === 'exact' && part.text === raw && part.spans.length === 0) {
    return
  }
  const parsed = parseJournalRow(raw)
  if (
    !parsed.ok ||
    parsed.row.kind !== 'item' ||
    parsed.row.body.kind !== 'tool-call' ||
    !parsed.row.body.output ||
    part.representation !== 'summarized' ||
    projection !== 'tools'
  ) {
    throw new Error('Unexpected benchmark representation')
  }
  const row = parsed.row
  const body = parsed.row.body
  const expected = {
    ...row,
    body: {
      ...body,
      output: {
        ...body.output,
        head: `[Historical tool output retained; source ${part.version.sha256}. Retrieve the original before relying on omitted output.]`
      }
    }
  }
  const [span] = part.spans
  if (
    part.text !== JSON.stringify(expected) ||
    part.spans.length !== 1 ||
    !span ||
    conversationEvidenceKey(span.version) !== conversationEvidenceKey(part.version) ||
    span.startByte !== 0 ||
    span.endByte !== Buffer.byteLength(raw)
  ) {
    throw new Error('Projected tool integrity mismatch')
  }
}

export async function auditPreparationBenchmarkSources(
  db: Database.Database,
  manifest: ConversationContextManifest,
  sourceCount: number,
  expectedRoot: string,
  enumerationRoot: string,
  signal: AbortSignal,
  options?: { projection: 'exact' | 'tools'; exportScope?: ConversationExportScope }
) {
  const exportScope = options?.exportScope
  const actual = createHash('sha256')
  let count = 0,
    cursor = 0,
    summarizedSourceCount = 0,
    exportedSourceCount = 0
  const audit = async (part: (typeof manifest.projection)[number]) => {
    const ref = part.version.source
    const raw = db
      .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?')
      .get(ref.sessionId, ref.epoch, ref.sequence)?.row_json
    if (typeof raw !== 'string') {
      throw new Error('Canonical integrity mismatch')
    }
    auditPreparationBenchmarkPart(raw, part, options?.projection ?? 'exact')
    if (part.representation === 'summarized') {
      summarizedSourceCount++
    }
    if (exportScope) {
      if (!part.artifactId) {
        throw new Error('Missing source export')
      }
      const proof = readConversationExportProof(db, {
        ownerId: part.artifactId,
        conversationId: manifest.conversationId,
        contextGeneration: manifest.contextGeneration,
        version: part.version
      })
      if (!proof) {
        throw new Error('Missing source export proof')
      }
      const { artifactVersion, ...offsets } = proof
      const validator = createConversationContextRowValidator({
        byteLength: Buffer.byteLength(raw)
      })
      validator.write(raw)
      const validated = validator.end()
      for await (const original of streamConversationExportRows({
        ...exportScope,
        artifact: {
          ownerId: part.artifactId,
          version: artifactVersion,
          path: join(
            agentSessionAttachmentStoreRoot(exportScope.stateDirectory),
            artifactVersion.uploadId,
            artifactVersion.name
          )
        },
        rows: [
          {
            version: part.version,
            ...offsets,
            kind: validated.envelope.kind,
            mutationCount: validated.mutationCount,
            substitutedValidationPaths: validated.substitutedPaths
          }
        ]
      })) {
        const hash = createHash('sha256')
        let bytes = 0
        for await (const chunk of original.chunks) {
          hash.update(chunk)
          bytes += chunk.byteLength
        }
        if (hash.digest('hex') !== part.version.sha256 || bytes !== Buffer.byteLength(raw)) {
          throw new Error('Exported canonical integrity mismatch')
        }
        exportedSourceCount++
      }
    }
    actual.update(conversationEvidenceKey(part.version)).update('\n')
    count++
  }
  if (manifest.evidenceIndex) {
    while (true) {
      signal.throwIfAborted()
      const page = readConversationManifestParts(db, manifest.evidenceIndex.indexId, cursor, 128)
      if (!page.length) {
        break
      }
      for (const row of page) {
        await audit(row.part)
        cursor = row.ordinal
      }
      await yieldLoop()
    }
  } else {
    for (const part of manifest.projection) {
      await audit(part)
    }
  }
  const integrity =
    count === sourceCount &&
    actual.digest('hex') === expectedRoot &&
    enumerationRoot === expectedRoot &&
    (!exportScope || exportedSourceCount === count)
  if (!integrity) {
    throw new Error('Incomplete source enumeration')
  }
  return { integrity, count, summarizedSourceCount, exportedSourceCount }
}
