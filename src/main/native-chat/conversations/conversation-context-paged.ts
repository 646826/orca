import { createHash } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import type {
  ConversationContextInput,
  ConversationContextOriginal,
  ConversationContextRepresentation,
  ConversationContextResult,
  ConversationEvidenceGap
} from '../../../shared/conversation-handoff'
import { compileConversationContext, conversationEvidenceKey } from './conversation-context-policy'
import {
  validateConversationPageEvidence,
  type ConversationPageEvidenceResolvers
} from './conversation-context-page-evidence'
import { conversationContextDigest } from './conversation-context-consent'
import { conversationContextEnvelope } from './conversation-context-envelope'
import { hasConversationRepresentationCoverage } from './conversation-context-index-delta'
import { conversationRepresentationRequiresInline } from './conversation-context-constraints'
import { assertConversationCoverageRevision } from './conversation-context-authority-revision'
import {
  appendConversationManifestParts,
  createConversationManifestParts,
  discardConversationManifestParts,
  sealConversationManifestParts
} from './conversation-context-parts'

const MAX_REFERENCE_BYTES = 1024 * 1024

/** Preparation only. Durable admission separately verifies every indexed source and disclosure. */
export async function compileConversationContextPages(
  input: Omit<ConversationContextInput, 'originals' | 'projection' | 'evidenceIndex'> &
    ConversationPageEvidenceResolvers & {
      db: Database.Database
      expected: { sourceCount: number; orderedVersionDigest: string }
      rows: AsyncIterable<{
        original: ConversationContextOriginal
        representation: ConversationContextRepresentation
      }>
      maxInlineBytes: number
      coverage?: { revision: number; nativeIdentityDigest: string }
    }
): Promise<ConversationContextResult> {
  if (input.db.isTransaction) {
    throw new Error('Paged compiler must run outside writer transaction')
  }
  if (
    !Number.isSafeInteger(input.maxInlineBytes) ||
    input.maxInlineBytes < 1 ||
    !Number.isSafeInteger(input.expected.sourceCount) ||
    input.expected.sourceCount < 0 ||
    !/^[a-f0-9]{64}$/.test(input.expected.orderedVersionDigest)
  ) {
    return { kind: 'refused', reason: 'invalid-input' }
  }
  if (input.policy !== 'budgeted' && input.policy !== 'full') {
    return { kind: 'refused', reason: 'unsupported-representation' }
  }
  const indexId = createConversationManifestParts(input.db, input)
  let retained = false
  try {
    const hash = createHash('sha256')
    const inlineOriginals = new Map<string, ConversationContextOriginal>(),
      inlineProjection = new Map<string, ConversationContextRepresentation>()
    let count = 0,
      staged = 0,
      pageBytes = 0,
      inlineBytes = Buffer.byteLength(JSON.stringify(input.mandatory))
    let page: ConversationContextRepresentation[] = [],
      gaps: ConversationEvidenceGap[] = []
    const flush = () => {
      if (!page.length) {
        return
      }
      appendConversationManifestParts(input.db, indexId, staged, page, gaps)
      staged += page.length
      page = []
      gaps = []
      pageBytes = 0
    }
    for await (const entry of input.rows) {
      if (input.signal.aborted) {
        return { kind: 'refused', reason: 'cancelled' }
      }
      const { original, representation } = entry
      const validated = await validateConversationPageEvidence({
        ...input,
        originals: [],
        projection: [],
        original,
        representation,
        maxReferenceBytes: MAX_REFERENCE_BYTES
      })
      if (validated.kind === 'refused') {
        return validated
      }
      const covered =
        input.policy === 'budgeted' &&
        input.coverage &&
        !conversationRepresentationRequiresInline(input, representation) &&
        hasConversationRepresentationCoverage(
          input.db,
          {
            target: input.target,
            targetBindingDigest: conversationContextDigest(input.target),
            contextGeneration: input.contextGeneration,
            nativeIdentityDigest: input.coverage.nativeIdentityDigest
          },
          representation
        )
      if (representation.text !== undefined && !covered) {
        for (const [i, source] of validated.originals.entries()) {
          const key = conversationEvidenceKey(source.version)
          const selected = validated.projection[i]
          if (inlineOriginals.has(key) && i !== 0) {
            continue
          }
          const previousPart = inlineProjection.get(key)
          inlineBytes += Buffer.byteLength(JSON.stringify(selected))
          if (previousPart) {
            inlineBytes -= Buffer.byteLength(JSON.stringify(previousPart))
          }
          if (inlineBytes > input.maxInlineBytes) {
            return { kind: 'refused', reason: 'resource-limit' }
          }
          inlineOriginals.set(key, source)
          inlineProjection.set(key, selected)
        }
      }
      hash.update(conversationEvidenceKey(original.version)).update('\n')
      count++
      if (count > input.expected.sourceCount) {
        return { kind: 'refused', reason: 'invalid-provenance' }
      }
      const bytes = Buffer.byteLength(JSON.stringify({ part: representation, gaps: original.gaps }))
      if (pageBytes + bytes > 2 * 1024 * 1024) {
        flush()
      }
      pageBytes += bytes
      page.push(representation)
      gaps.push(...original.gaps)
      if (page.length === 128) {
        flush()
      }
    }
    if (
      count !== input.expected.sourceCount ||
      hash.digest('hex') !== input.expected.orderedVersionDigest
    ) {
      return { kind: 'refused', reason: 'missing-representation' }
    }
    flush()
    if (input.signal.aborted) {
      return { kind: 'refused', reason: 'cancelled' }
    }
    const originals = [...inlineOriginals.values()],
      projection = [...inlineProjection.values()]
    for (const part of projection) {
      const selected = input.db
        .prepare(
          'SELECT part_json FROM conversation_manifest_parts WHERE index_id=? AND source_key=?'
        )
        .get(indexId, conversationContextDigest(part.version))
      if (
        typeof selected?.part_json !== 'string' ||
        conversationContextDigest(JSON.parse(selected.part_json).part) !==
          conversationContextDigest(part)
      ) {
        return { kind: 'refused', reason: 'invalid-provenance' }
      }
    }
    const evidenceIndex = await sealConversationManifestParts(input.db, indexId, input.signal)
    if (
      Buffer.byteLength(conversationContextEnvelope({ ...input, projection, evidenceIndex })) >
      input.maxInlineBytes
    ) {
      return { kind: 'refused', reason: 'resource-limit' }
    }
    const result = compileConversationContext({ ...input, originals, projection, evidenceIndex })
    if (input.coverage) {
      assertConversationCoverageRevision(input.db, input.coverage.revision)
    }
    if (result.kind === 'compiled') {
      input.db
        .prepare('INSERT INTO conversation_manifest_compilations VALUES(?,?,?,?,?)')
        .run(
          indexId,
          result.manifest.manifestId,
          evidenceIndex.rootDigest,
          count,
          input.expected.orderedVersionDigest
        )
      retained = true
    }
    return result
  } finally {
    if (!retained) {
      await discardConversationManifestParts(input.db, indexId)
    }
  }
}
