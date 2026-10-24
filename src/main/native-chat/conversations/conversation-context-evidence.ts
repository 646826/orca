import { createHash } from 'node:crypto'
import { canonicalUserConstraint } from './conversation-context-constraints'
import type {
  ConversationContextInput,
  ConversationContextResult,
  ConversationEvidenceVersion
} from '../../../shared/conversation-handoff'

export function conversationEvidenceKey(version: ConversationEvidenceVersion): string {
  const source = version.source
  return JSON.stringify([
    source.sessionId,
    source.epoch,
    source.sequence,
    source.itemId ?? null,
    source.itemRevision ?? null,
    source.batchIndex ?? null,
    version.sha256
  ])
}
function decodedField(json: string | undefined, pointer: string): string | null {
  if (json === undefined || !pointer.startsWith('/')) {
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  for (const key of pointer
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
      return null
    }
    const property = Object.getOwnPropertyDescriptor(value, key)
    value = property?.value
  }
  return typeof value === 'string' ? value : null
}

export function validateConversationContextEvidence(
  input: ConversationContextInput
): Extract<ConversationContextResult, { kind: 'refused' }> | null {
  if (input.signal.aborted) {
    return { kind: 'refused', reason: 'cancelled' }
  }
  if (
    input.evidenceIndex &&
    input.policy !== 'budgeted' &&
    (input.policy !== 'full' || input.evidenceIndex.partCount !== input.projection.length)
  ) {
    return { kind: 'refused', reason: 'unsupported-representation' }
  }
  const originals = new Map(
    input.originals.map((source) => [conversationEvidenceKey(source.version), source])
  )
  if (
    originals.size !== input.originals.length ||
    !Number.isSafeInteger(input.contextGeneration) ||
    input.contextGeneration < 1
  ) {
    return { kind: 'refused', reason: 'invalid-input' }
  }
  const represented = new Map(
    input.projection.map((part) => [conversationEvidenceKey(part.version), part])
  )
  if (represented.size !== input.projection.length) {
    return { kind: 'refused', reason: 'invalid-provenance' }
  }
  const gaps = [...(input.gaps ?? []), ...input.originals.flatMap((source) => source.gaps)]
  if (gaps.some((gap) => gap.critical)) {
    return { kind: 'refused', reason: 'critical-gap' }
  }
  if (
    input.policy !== 'fresh' &&
    (represented.size !== originals.size ||
      [...originals.keys()].some((key) => !represented.has(key)))
  ) {
    return { kind: 'refused', reason: 'missing-representation' }
  }
  if (input.policy === 'fresh' && (input.projection.length !== 0 || input.originals.length !== 0)) {
    return { kind: 'refused', reason: 'invalid-input' }
  }
  for (const part of input.projection) {
    if (input.signal.aborted) {
      return { kind: 'refused', reason: 'cancelled' }
    }
    const original = originals.get(conversationEvidenceKey(part.version))
    if (!original) {
      return { kind: 'refused', reason: 'invalid-provenance' }
    }
    if (
      original.text !== undefined &&
      createHash('sha256').update(original.text).digest('hex') !== original.version.sha256
    ) {
      return { kind: 'refused', reason: 'invalid-provenance' }
    }
    if (
      original.text === undefined &&
      (!original.artifactId || !original.byteLength || part.artifactId !== original.artifactId)
    ) {
      return { kind: 'refused', reason: 'invalid-provenance' }
    }
    if (
      part.representation === 'exact' &&
      (original.text === undefined || part.text !== original.text)
    ) {
      return { kind: 'refused', reason: 'invalid-provenance' }
    }
    if (
      part.representation === 'transport-projected'
        ? !part.text ||
          !part.artifactId ||
          !part.spans.length ||
          !part.transportProjection ||
          input.verifyTransportProjection?.(original, part) !== true
        : part.transportProjection !== undefined
    ) {
      return { kind: 'refused', reason: 'invalid-provenance' }
    }
    if (part.representation === 'summarized' && (!part.text || part.spans.length === 0)) {
      return { kind: 'refused', reason: 'invalid-provenance' }
    }
    for (const span of part.spans) {
      const cited = originals.get(conversationEvidenceKey(span.version))
      const bytes =
        cited?.text === undefined ? cited?.byteLength : Buffer.byteLength(cited.text, 'utf8')
      if (
        !cited ||
        bytes === undefined ||
        !Number.isSafeInteger(span.startByte) ||
        !Number.isSafeInteger(span.endByte) ||
        span.startByte < 0 ||
        span.endByte <= span.startByte ||
        span.endByte > bytes
      ) {
        return { kind: 'refused', reason: 'invalid-provenance' }
      }
    }
    if (
      (part.representation === 'retrievable-only' || part.representation === 'summarized') &&
      !part.artifactId
    ) {
      return { kind: 'refused', reason: 'unsupported-representation' }
    }
    if (
      (part.representation === 'retrievable-only' ||
        (part.representation === 'summarized' && part.artifactId !== undefined)) &&
      input.target.retrieval !== 'verified'
    ) {
      return { kind: 'refused', reason: 'unsupported-representation' }
    }
    if (
      (part.representation === 'missing' || part.representation === 'retrievable-only') &&
      part.text !== undefined
    ) {
      return { kind: 'refused', reason: 'invalid-provenance' }
    }
  }
  const constraints = new Set(input.mandatory.map((constraint) => constraint.id))
  if (constraints.size !== input.mandatory.length) {
    return { kind: 'refused', reason: 'invalid-provenance' }
  }
  for (const constraint of input.mandatory) {
    if (
      !constraint.text ||
      constraint.sources.length === 0 ||
      constraint.supersedes.includes(constraint.id) ||
      constraint.supersedes.some((id) => constraints.has(id))
    ) {
      return { kind: 'refused', reason: 'invalid-provenance' }
    }
    const fields = constraint.decodedFields ?? []
    for (const field of fields) {
      const text = decodedField(
        originals.get(conversationEvidenceKey(field.version))?.text,
        field.jsonPointer
      )
      if (
        text === null ||
        createHash('sha256').update(text).digest('hex') !== field.decodedSha256 ||
        !constraint.sources.some(
          (version) => conversationEvidenceKey(version) === conversationEvidenceKey(field.version)
        )
      ) {
        return { kind: 'refused', reason: 'invalid-provenance' }
      }
    }
    if (
      !constraint.sources.some((version) =>
        canonicalUserConstraint(
          originals.get(conversationEvidenceKey(version))?.text,
          constraint.text
        )
      )
    ) {
      return { kind: 'refused', reason: 'invalid-provenance' }
    }
    if (constraint.sources.some((version) => !originals.has(conversationEvidenceKey(version)))) {
      return { kind: 'refused', reason: 'invalid-provenance' }
    }
    if (
      !constraint.sources.some((version) =>
        represented.get(conversationEvidenceKey(version))?.text?.includes(constraint.text)
      ) &&
      !fields.some((field) =>
        decodedField(
          represented.get(conversationEvidenceKey(field.version))?.text,
          field.jsonPointer
        )?.includes(constraint.text)
      )
    ) {
      return { kind: 'refused', reason: 'mandatory-not-inline' }
    }
  }
  if (
    input.policy === 'full' &&
    input.projection.some(
      (part) => part.representation !== 'exact' && part.representation !== 'transport-projected'
    )
  ) {
    return { kind: 'refused', reason: 'unsupported-representation' }
  }
  return null
}
