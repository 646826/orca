import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import type {
  ConversationContextOriginal,
  ConversationContextRepresentation,
  ConversationContextRefusal,
  ConversationEvidenceVersion
} from '../../../shared/conversation-handoff'
import { createConversationToolEvidenceProjection } from './conversation-context-row-validation'
import { conversationCanonicalRowBodies } from './conversation-canonical-row'
import { MAX_JOURNAL_LIFECYCLE_BATCH_BYTES } from '../agent-session-journal/journal-row-schema'

export type ConversationDisclosedRowStream = {
  version: ConversationEvidenceVersion
  byteLength: number
  artifactId: string
  chunks: AsyncIterable<Uint8Array>
}
export class ConversationRowProjectionError extends Error {
  constructor(readonly reason: ConversationContextRefusal['reason']) {
    super(reason)
  }
}

/** Projection changes only the bounded tool-output leaves; hashes always cover original bytes. */
export async function projectConversationDisclosedRow(
  source: ConversationDisclosedRowStream,
  signal: AbortSignal
) {
  const parser = createConversationToolEvidenceProjection({
    referenceText: `[Historical tool output retained; source ${source.version.sha256}. Retrieve the original before relying on omitted output.]`,
    byteLength: source.byteLength
  })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const decode = (bytes?: Uint8Array): string => {
    try {
      return decoder.decode(bytes, { stream: bytes !== undefined })
    } catch {
      throw new ConversationRowProjectionError('invalid-provenance')
    }
  }
  const hash = createHash('sha256')
  let bytes = 0,
    raw: string | undefined = ''
  for await (const chunk of source.chunks) {
    if (signal.aborted) {
      throw new ConversationRowProjectionError('cancelled')
    }
    bytes += chunk.byteLength
    if (bytes > source.byteLength) {
      throw new ConversationRowProjectionError('invalid-provenance')
    }
    hash.update(chunk)
    const text = decode(chunk)
    parser.write(text)
    raw = raw !== undefined && bytes <= MAX_JOURNAL_LIFECYCLE_BATCH_BYTES ? raw + text : undefined
    await setImmediate()
  }
  if (signal.aborted) {
    throw new ConversationRowProjectionError('cancelled')
  }
  const tail = decode()
  parser.write(tail)
  if (raw !== undefined) {
    raw += tail
  }
  if (bytes !== source.byteLength || hash.digest('hex') !== source.version.sha256) {
    throw new ConversationRowProjectionError('invalid-provenance')
  }
  const { projectedRow: row, substitutedPaths } = parser.end()
  if (row.epoch !== source.version.source.epoch || row.seq !== source.version.source.sequence) {
    throw new ConversationRowProjectionError('invalid-provenance')
  }
  const transformed = substitutedPaths.length > 0
  const text = transformed ? JSON.stringify(row) : raw
  if (text === undefined) {
    throw new ConversationRowProjectionError('resource-limit')
  }
  const gaps = conversationCanonicalRowBodies(row).some(
    (body) =>
      (body.kind === 'tool-call' && body.output?.truncated) ||
      (body.kind === 'diff' && body.patch.truncated)
  )
    ? [{ source: source.version.source, reason: 'captured-incomplete' as const, critical: false }]
    : []
  const original: ConversationContextOriginal = {
    version: source.version,
    ...(transformed ? {} : { text }),
    byteLength: bytes,
    artifactId: source.artifactId,
    kind:
      row.kind === 'item' && row.body.kind === 'tool-call'
        ? 'tool'
        : row.kind === 'item' && row.body.kind === 'message' && row.body.role === 'user'
          ? 'user'
          : 'historical-data',
    gaps
  }
  const projection: ConversationContextRepresentation = {
    version: source.version,
    representation: transformed ? 'summarized' : 'exact',
    text,
    artifactId: source.artifactId,
    spans: transformed ? [{ version: source.version, startByte: 0, endByte: bytes }] : []
  }
  return { original, projection, row, substitutedPaths }
}
