import { ConversationPreparationStaleError } from './conversation-preparation-stale'
import { readConversation } from './conversation-read-model'
import { conversationContextDigest } from './conversation-context-consent'
import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import type Database from '../../sqlite/sync-database'
import {
  isConversationSegment,
  type ConversationSourceRef
} from '../../../shared/conversation-record'
import type { ConversationEvidenceVersion } from '../../../shared/conversation-handoff'
import { createConversationCanonicalRowValidator } from './conversation-canonical-row-validation'
import { readConversationSourceSegmentId } from './conversation-source-attribution'
import { readConversationEnrollmentOrigin } from './conversation-origin-capture'
import { assertConversationOrigin, parseConversationOrigin } from './conversation-origin'
import type { ConversationPreparationSources } from './conversation-preparation-sources'

export type ConversationPreparationSourceRow = {
  version: ConversationEvidenceVersion
  segmentId: string
  attributionDigest: string
  byteLength: number
  kind: ReturnType<
    ReturnType<typeof createConversationCanonicalRowValidator>['end']
  >['envelope']['kind']
  mutationCount: number
  capturedIncomplete: boolean
  /** Exhaust before use: integrity is checked at end; original bytes, never projected placeholders. */
  readChunks: () => AsyncIterable<Uint8Array>
}
async function* chunks(
  db: Database.Database,
  source: ConversationSourceRef,
  length: number,
  signal: AbortSignal
) {
  const statement = db.prepare(
    'SELECT substr(CAST(row_json AS BLOB),?,?) bytes FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?'
  )
  for (let offset = 0; offset < length;) {
    signal.throwIfAborted()
    const count = Math.min(1024 * 1024, length - offset)
    const bytes = statement.get(
      offset + 1,
      count,
      source.sessionId,
      source.epoch,
      source.sequence
    )?.bytes
    if (!(bytes instanceof Uint8Array) || bytes.length !== count) {
      throw new Error('Preparation source missing')
    }
    yield bytes
    offset += count
    if (offset < length) {
      await setImmediate(undefined, { signal })
    }
  }
}
function selectedOrigin(
  db: Database.Database,
  snapshot: Pick<ConversationPreparationSources, 'conversationId' | 'contextGeneration'>,
  source: ConversationSourceRef,
  mutationCount: number,
  sha256: string
): { segmentId: string; attributionDigest: string } | null {
  const saved = db
    .prepare(
      'SELECT atom_path,origin_json FROM conversation_origin_rows WHERE session_id=? AND epoch=? AND sequence=? ORDER BY atom_path'
    )
    .all(source.sessionId, source.epoch, source.sequence)
  const paths = new Set([
    '$',
    ...Array.from({ length: mutationCount }, (_, i) => `$.mutations[${i}]`)
  ])
  let segments: string[] = []
  if (saved.length) {
    if (saved.length !== paths.size) {
      throw new Error('Preparation atom attribution missing')
    }
    segments = saved.map((row) => {
      if (
        typeof row.atom_path !== 'string' ||
        !paths.delete(row.atom_path) ||
        typeof row.origin_json !== 'string'
      ) {
        throw new Error('Preparation source origin unknown')
      }
      const origin = parseConversationOrigin(JSON.parse(row.origin_json))
      assertConversationOrigin(db, source.sessionId, origin)
      return origin.segmentId
    })
  } else if (mutationCount > 0) {
    const enrolled = readConversationEnrollmentOrigin(db, source)
    if (enrolled) {
      segments = [enrolled.segmentId]
    } else {
      const atoms = db
        .prepare(
          'SELECT * FROM conversation_source_atoms WHERE session_id=? AND epoch=? AND sequence=? ORDER BY atom_path'
        )
        .all(source.sessionId, source.epoch, source.sequence)
      if (atoms.length !== paths.size) {
        throw new Error('Preparation atom attribution missing')
      }
      segments = atoms.map((atom) => {
        if (
          typeof atom.atom_path !== 'string' ||
          !paths.delete(atom.atom_path) ||
          atom.row_sha256 !== sha256 ||
          atom.mutation_count !== mutationCount ||
          typeof atom.segment_id !== 'string'
        ) {
          throw new Error('Preparation atom attribution invalid')
        }
        assertConversationOrigin(db, source.sessionId, {
          conversationId: snapshot.conversationId,
          segmentId: atom.segment_id,
          contextGeneration: Number(atom.context_generation),
          nativeBindingGeneration: Number(atom.native_binding_generation)
        })
        return atom.segment_id
      })
    }
  } else {
    const segment = readConversationSourceSegmentId(db, source)
    if (!segment) {
      throw new Error('Preparation source origin unknown')
    }
    segments = [segment]
  }
  const classified = segments.map((id) => {
    const row = db
      .prepare('SELECT record_json FROM conversation_segments WHERE segment_id=?')
      .get(id)
    const segment: unknown =
      typeof row?.record_json === 'string' ? JSON.parse(row.record_json) : null
    if (
      !isConversationSegment(segment) ||
      segment.sessionId !== source.sessionId ||
      segment.conversationId !== snapshot.conversationId
    ) {
      throw new Error('Preparation source origin invalid')
    }
    return {
      id,
      contextGeneration: segment.contextGeneration,
      nativeBindingGeneration: segment.nativeBindingGeneration,
      lifecycle: segment.lifecycle ?? 'activated',
      current:
        segment.contextGeneration === snapshot.contextGeneration &&
        segment.lifecycle !== 'candidate'
    }
  })
  if (classified.every((value) => !value.current)) {
    return null
  }
  if (classified.some((value) => !value.current)) {
    throw new Error('Preparation mixed-generation batch unsupported')
  }
  return { segmentId: classified[0]!.id, attributionDigest: conversationContextDigest(classified) }
}

/** Internal independent traversal; callers receive no way to choose a subset of the frozen prefixes. */
export async function* scanConversationPreparationSources(
  db: Database.Database,
  snapshot: Pick<
    ConversationPreparationSources,
    'ownerId' | 'conversationId' | 'contextGeneration' | 'boundaries'
  >,
  signal: AbortSignal
): AsyncGenerator<ConversationPreparationSourceRow> {
  let seen = 0
  const assertGeneration = () => {
    if (
      readConversation(db, snapshot.conversationId)?.contextGeneration !==
      snapshot.contextGeneration
    ) {
      throw new ConversationPreparationStaleError('Preparation generation changed')
    }
  }
  assertGeneration()
  for (const boundary of snapshot.boundaries) {
    const held = db
      .prepare(
        'SELECT end_sequence FROM journal_epoch_pins WHERE owner_id=? AND session_id=? AND epoch=?'
      )
      .get(snapshot.ownerId, boundary.sessionId, boundary.epoch)
    if (held?.end_sequence !== boundary.endSequence) {
      throw new Error('Preparation pin missing')
    }
    for (let sequence = 1; sequence <= boundary.endSequence; sequence++) {
      signal.throwIfAborted()
      const source = { sessionId: boundary.sessionId, epoch: boundary.epoch, sequence }
      const stored = db
        .prepare(
          'SELECT octet_length(row_json) bytes FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?'
        )
        .get(source.sessionId, source.epoch, sequence)
      const length = stored?.bytes
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 1) {
        throw new Error('Preparation source missing')
      }
      const hash = createHash('sha256'),
        decoder = new TextDecoder('utf-8', { fatal: true }),
        validator = createConversationCanonicalRowValidator(db, snapshot, source, length)
      for await (const bytes of chunks(db, source, length, signal)) {
        hash.update(bytes)
        validator.write(decoder.decode(bytes, { stream: true }))
      }
      validator.write(decoder.decode())
      const metadata = validator.end(),
        sha256 = hash.digest('hex')
      if (metadata.envelope.epoch !== source.epoch || metadata.envelope.sequence !== sequence) {
        throw new Error('Preparation source integrity mismatch')
      }
      // Queue facts stay canonical but are not delivered conversation turns.
      if (metadata.envelope.kind === 'queue') {
        if (++seen % 128 === 0) {
          await setImmediate(undefined, { signal })
        }
        continue
      }
      const selected = selectedOrigin(db, snapshot, source, metadata.mutationCount, sha256)
      if (selected) {
        yield {
          version: { source, sha256 },
          ...selected,
          byteLength: length,
          kind: metadata.envelope.kind,
          mutationCount: metadata.mutationCount,
          capturedIncomplete: metadata.capturedIncomplete,
          readChunks: async function* () {
            const assertReadable = () => {
              assertGeneration()
              if (
                db
                  .prepare(
                    'SELECT end_sequence FROM journal_epoch_pins WHERE owner_id=? AND session_id=? AND epoch=?'
                  )
                  .get(snapshot.ownerId, boundary.sessionId, boundary.epoch)?.end_sequence !==
                boundary.endSequence
              ) {
                throw new Error('Preparation pin missing')
              }
            }
            assertReadable()
            const verify = createHash('sha256')
            for await (const bytes of chunks(db, source, length, signal)) {
              verify.update(bytes)
              yield bytes
            }
            assertReadable()
            if (
              verify.digest('hex') !== sha256 ||
              selectedOrigin(db, snapshot, source, metadata.mutationCount, sha256)
                ?.attributionDigest !== selected.attributionDigest
            ) {
              throw new Error('Preparation source integrity changed')
            }
          }
        }
      }
      if (++seen % 128 === 0) {
        await setImmediate(undefined, { signal })
      }
    }
  }
}
