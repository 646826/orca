import {
  assertConversationSourceVersionPin,
  recordConversationSourceVersion
} from './conversation-source-version'
export {
  recordConversationSourceVersion,
  type ConversationCanonicalSourceVersionInput
} from './conversation-source-version'
import { assertJournalWritable } from '../agent-session-journal/journal-write-guards'
import { createHash } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import {
  isConversationSegment,
  type ConversationSourceRef
} from '../../../shared/conversation-record'
import type { JournalEpochPin } from '../agent-session-journal/journal-epoch-pins'
import type { JournalOperationReceipt } from '../agent-session-journal/journal-row-writer'
import {
  parseJournalRow,
  MAX_JOURNAL_LIFECYCLE_BATCH_BYTES,
  MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS
} from '../agent-session-journal/journal-row-schema'
import { ConversationRefusal, readConversation } from './conversation-read-model'
export { createConversationSourceAtomTablesSql } from './conversation-source-atoms-schema'

export type ConversationSourceAtomOrigin = {
  conversationId: string
  segmentId: string
  sessionId: string
  contextGeneration: number
  nativeBindingGeneration: number
}
function checkedOrigin(db: Database.Database, origin: ConversationSourceAtomOrigin): boolean {
  const row = db
    .prepare('SELECT record_json FROM conversation_segments WHERE segment_id=?')
    .get(origin.segmentId)
  if (typeof row?.record_json !== 'string') {
    return false
  }
  let segment: unknown
  try {
    segment = JSON.parse(row.record_json)
  } catch {
    return false
  }
  return (
    isConversationSegment(segment) &&
    segment.conversationId === origin.conversationId &&
    segment.sessionId === origin.sessionId &&
    segment.contextGeneration === origin.contextGeneration &&
    segment.nativeBindingGeneration === origin.nativeBindingGeneration
  )
}

/** Reads only one bounded canonical batch outside transactions, protected by the caller's dedicated frozen pin. */
export function prepareConversationSourceAtomReceipt(
  db: Database.Database,
  input: {
    pin: JournalEpochPin
    source: ConversationSourceRef
    envelopeOrigin: ConversationSourceAtomOrigin
    mutationOrigins: readonly { batchIndex: number; origin: ConversationSourceAtomOrigin }[]
  }
): JournalOperationReceipt {
  if (db.isTransaction) {
    throw new Error('prepare source atoms outside the transaction')
  }
  assertConversationSourceVersionPin(db, input)
  const source = { ...input.source }
  const length = db
    .prepare(
      'SELECT length(CAST(row_json AS BLOB)) bytes FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?'
    )
    .get(source.sessionId, source.epoch, source.sequence)?.bytes
  if (typeof length !== 'number') {
    throw new ConversationRefusal('missing-source')
  }
  if (length > MAX_JOURNAL_LIFECYCLE_BATCH_BYTES) {
    throw new RangeError('batch exceeds bounded atom preparation capacity')
  }
  const raw = db
    .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?')
    .get(source.sessionId, source.epoch, source.sequence)?.row_json
  if (typeof raw !== 'string') {
    throw new ConversationRefusal('missing-source')
  }
  const parsed = parseJournalRow(raw)
  if (!parsed.ok && parsed.unreadable) {
    assertJournalWritable(true, source.sessionId)
  }
  if (
    !parsed.ok ||
    parsed.row.kind !== 'lifecycle-batch' ||
    parsed.row.epoch !== source.epoch ||
    parsed.row.seq !== source.sequence
  ) {
    throw new ConversationRefusal('corrupt-record')
  }
  const row = parsed.row
  const sha256 = createHash('sha256').update(raw).digest('hex')
  const conversationId = input.envelopeOrigin.conversationId
  const mutationCount = row.mutations.length
  const atoms: {
    path: string
    origin: ConversationSourceAtomOrigin
    itemId: string | null
    revision: number | null
  }[] = [{ path: '$', origin: { ...input.envelopeOrigin }, itemId: null, revision: null }]
  const seen = new Set<number>()
  for (const selected of input.mutationOrigins) {
    const index = selected.batchIndex
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= row.mutations.length ||
      seen.has(index)
    ) {
      throw new ConversationRefusal('corrupt-record')
    }
    seen.add(index)
    const mutation = row.mutations[index]
    if (!mutation) {
      throw new ConversationRefusal('corrupt-record')
    }
    atoms.push({
      path: `$.mutations[${index}]`,
      origin: { ...selected.origin },
      itemId: mutation.itemId,
      revision: mutation.revision
    })
  }
  const version = {
    pin: { ...input.pin },
    source: { ...source },
    sha256,
    byteLength: length,
    kind: row.kind,
    mutationCount
  }
  return {
    write: (connection) => {
      if (connection !== db) {
        throw new ConversationRefusal('scope-mismatch')
      }
      recordConversationSourceVersion(connection, version)
      for (const atom of atoms) {
        if (
          atom.origin.sessionId !== source.sessionId ||
          atom.origin.conversationId !== conversationId ||
          !checkedOrigin(connection, atom.origin)
        ) {
          throw new ConversationRefusal('identity-mismatch')
        }
        const prior = connection
          .prepare(
            'SELECT segment_id,context_generation,native_binding_generation,row_sha256,mutation_count,item_id,item_revision FROM conversation_source_atoms WHERE session_id=? AND epoch=? AND sequence=? AND atom_path=?'
          )
          .get(source.sessionId, source.epoch, source.sequence, atom.path)
        if (
          prior &&
          (prior.segment_id !== atom.origin.segmentId ||
            prior.context_generation !== atom.origin.contextGeneration ||
            prior.native_binding_generation !== atom.origin.nativeBindingGeneration ||
            prior.row_sha256 !== sha256 ||
            prior.mutation_count !== mutationCount ||
            prior.item_id !== atom.itemId ||
            prior.item_revision !== atom.revision)
        ) {
          throw new ConversationRefusal('identity-mismatch')
        }
        connection
          .prepare('INSERT OR IGNORE INTO conversation_source_atoms VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(
            source.sessionId,
            source.epoch,
            source.sequence,
            atom.path,
            atom.origin.segmentId,
            atom.origin.contextGeneration,
            atom.origin.nativeBindingGeneration,
            sha256,
            mutationCount,
            atom.itemId,
            atom.revision
          )
      }
    },
    committed: () => {}
  }
}

export function authorizeConversationSourceAtoms(
  db: Database.Database,
  input: {
    conversationId: string
    contextGeneration: number
    source: ConversationSourceRef
    sha256: string
    mutationCount: number
  }
): boolean {
  if (
    !Number.isSafeInteger(input.mutationCount) ||
    input.mutationCount < 0 ||
    input.mutationCount > MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS
  ) {
    return false
  }
  const conversation = readConversation(db, input.conversationId)
  if (conversation?.contextGeneration !== input.contextGeneration) {
    return false
  }
  const { source } = input
  if (
    source.batchIndex !== undefined ||
    source.itemId !== undefined ||
    source.itemRevision !== undefined
  ) {
    return false
  }
  const version = db
    .prepare(
      'SELECT sha256,row_kind,mutation_count FROM conversation_source_versions WHERE session_id=? AND epoch=? AND sequence=?'
    )
    .get(source.sessionId, source.epoch, source.sequence)
  if (
    version?.sha256 !== input.sha256 ||
    version.row_kind !== 'lifecycle-batch' ||
    version.mutation_count !== input.mutationCount
  ) {
    return false
  }
  const atoms = db
    .prepare(
      'SELECT atom_path,segment_id,context_generation,native_binding_generation,row_sha256,mutation_count FROM conversation_source_atoms WHERE session_id=? AND epoch=? AND sequence=?'
    )
    .all(source.sessionId, source.epoch, source.sequence)
  if (atoms.length !== input.mutationCount + 1) {
    return false
  }
  const paths = new Set([
    '$',
    ...Array.from({ length: input.mutationCount }, (_, i) => `$.mutations[${i}]`)
  ])
  return (
    atoms.every((atom) => {
      if (
        typeof atom.atom_path !== 'string' ||
        !paths.delete(atom.atom_path) ||
        typeof atom.segment_id !== 'string' ||
        atom.context_generation !== input.contextGeneration ||
        typeof atom.native_binding_generation !== 'number' ||
        atom.row_sha256 !== input.sha256 ||
        atom.mutation_count !== input.mutationCount
      ) {
        return false
      }
      return checkedOrigin(db, {
        conversationId: input.conversationId,
        segmentId: atom.segment_id,
        sessionId: source.sessionId,
        contextGeneration: input.contextGeneration,
        nativeBindingGeneration: atom.native_binding_generation
      })
    }) && paths.size === 0
  )
}
