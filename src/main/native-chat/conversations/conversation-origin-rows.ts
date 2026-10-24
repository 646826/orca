import { readConversationRetiredSubmissionOrigin } from './conversation-retired-submission-origin'
import { itemKeys, rowKeys } from './conversation-origin-row-keys'
import { readQueuedConversationOrigin } from '../agent-session-journal/queued-message-origin'
import { readConversationClearRowOrigin } from './conversation-clear-origin'
import { readConversationEpochOrigin } from './conversation-epoch-origin'
import { resolveConversationOriginEnvelope } from './conversation-origin-envelope'
import {
  readConversationCapturedScope,
  readConversationAdmittedSubmissionOrigin
} from './conversation-origin-capture'
import { pinJournalEpoch } from '../agent-session-journal/journal-epoch-pins'
import type Database from '../../sqlite/sync-database'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import type { JournalRowTransactionHook } from '../agent-session-journal/journal-row-writer'
import {
  ConversationOriginUnresolvedError,
  type ConversationOriginScope,
  bindConversationOrigin,
  readConversationOrigin,
  parseConversationOriginKeys,
  parseConversationOrigin,
  assertConversationOrigin,
  type ConversationOriginKey,
  type ConversationOrigin
} from './conversation-origin'
import { attributeConversationSourceBoundary } from './conversation-source-attribution'

function resolveKeys(
  db: Database.Database,
  sessionId: string,
  keys: ConversationOriginKey[],
  scope: ConversationOriginScope | null
): ConversationOrigin | null {
  if (!scope) {
    return null
  }
  // An item's durable identity wins over a later turn restatement.
  for (const key of keys) {
    const origin = readConversationOrigin(db, sessionId, key, scope.nativeBindingGeneration)
    if (
      origin &&
      origin.contextGeneration === scope.contextGeneration &&
      origin.conversationId === scope.conversationId
    ) {
      if (keys[0]?.kind === 'item') {
        bindConversationOrigin(db, { sessionId, key: keys[0], origin })
      }
      return origin
    }
  }
  return null
}
function attribute(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  sequence: number,
  origin: ConversationOrigin
): void {
  attributeConversationSourceBoundary(db, origin.segmentId, sessionId, origin.contextGeneration, {
    sessionId,
    epoch,
    endSequence: sequence
  })
}
/** Resolve immutable acquisition/admission evidence per atom, never current-active state. */
export function createConversationOriginRowHook(
  sessionId: string,
  readCapturedScope: (
    db: Database.Database,
    row: JournalRow,
    atomPath: string
  ) => ConversationOriginScope | null = (db, row, path) =>
    readConversationCapturedScope(db, sessionId, row, path)
): JournalRowTransactionHook {
  return (db, row, restatement) => {
    if (!db.isTransaction) {
      throw new Error('conversation origin requires transaction')
    }
    if (!db.prepare('SELECT 1 FROM conversation_participants WHERE session_id=?').get(sessionId)) {
      return
    }
    const retirement = readConversationRetiredSubmissionOrigin(db, sessionId, row)
    if (row.kind !== 'epoch' && row.kind !== 'queue' && !retirement) {
      const pending = db
        .prepare(
          'SELECT origin_json FROM conversation_pending_native_identity WHERE session_id=? AND fence=? AND native_identity IS NULL'
        )
        .get(sessionId, row.fence)
      if (pending) {
        const admitted =
          row.kind === 'submission'
            ? readConversationAdmittedSubmissionOrigin(db, sessionId, row)
            : null
        // Admitted input is not a provider effect; every other pre-publication fact still taints.
        if (!admitted || JSON.stringify(admitted) !== pending.origin_json) {
          db.prepare(
            'UPDATE conversation_pending_native_identity SET effect_seen=1 WHERE session_id=? AND fence=? AND native_identity IS NULL'
          ).run(sessionId, row.fence)
        }
      }
    }
    const ownerId = `conversation-origin:${sessionId}`
    if (
      !db
        .prepare('SELECT 1 FROM journal_epoch_pins WHERE owner_id=? AND session_id=? AND epoch=?')
        .get(ownerId, sessionId, row.epoch)
    ) {
      pinJournalEpoch(db, { ownerId, sessionId, epoch: row.epoch, endSequence: row.seq })
    }
    const atoms = [{ path: '$', keys: rowKeys(row) }]
    if (row.kind === 'lifecycle-batch') {
      db.prepare('INSERT INTO conversation_origin_batch_envelopes VALUES(?,?,?,?)').run(
        sessionId,
        row.epoch,
        row.seq,
        row.mutations.length
      )
      row.mutations.forEach((mutation, index) =>
        atoms.push({ path: `$.mutations[${index}]`, keys: itemKeys(mutation) })
      )
    }
    for (const atom of atoms) {
      const continuity =
        atom.path === '$'
          ? (retirement ??
            readConversationClearRowOrigin(db, sessionId, row) ??
            readConversationEpochOrigin(db, sessionId, row, restatement))
          : null
      const queueOrigin =
        row.kind === 'queue' ? readQueuedConversationOrigin(db, sessionId, row.messageId) : null
      const scope =
        row.kind === 'queue' ? queueOrigin : (continuity ?? readCapturedScope(db, row, atom.path))
      const origin =
        row.kind === 'queue'
          ? queueOrigin
          : restatement
            ? continuity
            : (continuity ?? resolveKeys(db, sessionId, atom.keys, scope))
      if (origin && (restatement || row.kind === 'epoch')) {
        bindConversationOrigin(db, { sessionId, key: atom.keys[0]!, origin })
      }
      db.prepare('INSERT INTO conversation_origin_rows VALUES(?,?,?,?,?,?,?,?,?)').run(
        sessionId,
        row.epoch,
        row.seq,
        atom.path,
        JSON.stringify(atom.keys),
        origin ? JSON.stringify(origin) : null,
        scope?.conversationId ?? null,
        scope?.contextGeneration ?? null,
        scope?.nativeBindingGeneration ?? null
      )
      if (origin && atom.path === '$' && row.kind !== 'queue') {
        attribute(db, sessionId, row.epoch, row.seq, origin)
      }
      if (
        origin &&
        row.kind === 'dispatch' &&
        row.state === 'accepted' &&
        row.originCorrelation === 'exact' &&
        row.providerItemId
      ) {
        bindConversationOrigin(db, {
          sessionId,
          key: { kind: 'item', id: row.providerItemId },
          origin
        })
        resolveConversationOrigins(db, sessionId)
      }
    }
    if (row.kind === 'lifecycle-batch') {
      resolveConversationOriginEnvelope(db, sessionId, row.epoch, row.seq)
    }
  }
}
export function assertConversationOriginsResolved(
  db: Database.Database,
  conversationId: string,
  contextGeneration: number
): void {
  if (
    db
      .prepare(`SELECT 1 FROM conversation_origin_correlations r
      JOIN conversation_participants p ON p.session_id=r.session_id
      WHERE p.conversation_id=? AND r.resolved=0 AND
      (r.scope_json IS NULL OR json_extract(r.scope_json,'$.contextGeneration')=?) LIMIT 1`)
      .get(conversationId, contextGeneration)
  ) {
    throw new ConversationOriginUnresolvedError()
  }
  if (
    db
      .prepare(`SELECT 1 FROM conversation_origin_rows r JOIN conversation_participants p
    ON p.session_id=r.session_id WHERE p.conversation_id=? AND r.origin_json IS NULL
    AND (r.context_generation IS NULL OR r.context_generation=?)
    AND COALESCE((json_extract(r.keys_json,'$[0].kind')='event' AND json_extract(r.keys_json,'$[0].id') LIKE 'queue:%'),0)=0 LIMIT 1`)
      .get(conversationId, contextGeneration)
  ) {
    throw new ConversationOriginUnresolvedError()
  }
}
/** Bounded metadata only; canonical payload validation and hashing remain outside transactions. */
export function resolveConversationOrigins(
  db: Database.Database,
  sessionId: string,
  limit = 128
): number {
  if (!db.isTransaction || !Number.isSafeInteger(limit) || limit < 1 || limit > 128) {
    throw new Error('invalid origin resolution transaction or limit')
  }
  const rows = db
    .prepare(
      `SELECT r.epoch,r.sequence,r.atom_path,r.keys_json,r.conversation_id,r.context_generation,r.native_binding_generation FROM conversation_origin_rows r
       WHERE r.session_id=? AND r.origin_json IS NULL AND EXISTS (
         SELECT 1 FROM json_each(r.keys_json) k JOIN conversation_origin_bindings b
         ON b.session_id=r.session_id AND b.native_binding_generation=r.native_binding_generation AND b.key_kind=json_extract(k.value,'$.kind')
         AND b.key_id=json_extract(k.value,'$.id'))
       ORDER BY r.sequence,r.atom_path LIMIT ?`
    )
    .all(sessionId, limit)
  let resolved = 0
  for (const row of rows) {
    const keys = parseConversationOriginKeys(JSON.parse(String(row.keys_json)))
    const origin = resolveKeys(db, sessionId, keys, {
      conversationId: String(row.conversation_id),
      contextGeneration: Number(row.context_generation),
      nativeBindingGeneration: Number(row.native_binding_generation)
    })
    if (!origin) {
      continue
    }
    db.prepare(
      'UPDATE conversation_origin_rows SET origin_json=? WHERE session_id=? AND epoch=? AND sequence=? AND atom_path=? AND origin_json IS NULL'
    ).run(
      JSON.stringify(origin),
      sessionId,
      String(row.epoch),
      Number(row.sequence),
      String(row.atom_path)
    )
    if (row.atom_path === '$') {
      attribute(db, sessionId, String(row.epoch), Number(row.sequence), origin)
    }
    resolved++
    if (
      row.atom_path !== '$' &&
      resolveConversationOriginEnvelope(db, sessionId, String(row.epoch), Number(row.sequence))
    ) {
      resolved++
    }
  }
  return resolved
}

/** Only causal metadata; this is not a canonical hash or a delivery receipt. */
export function readConversationRowOrigins(
  db: Database.Database,
  source: {
    sessionId: string
    epoch: string
    sequence: number
  }
): { atomPath: string; origin: ConversationOrigin }[] {
  const rows = db
    .prepare(
      'SELECT atom_path,origin_json FROM conversation_origin_rows WHERE session_id=? AND epoch=? AND sequence=? ORDER BY atom_path'
    )
    .all(source.sessionId, source.epoch, source.sequence)
  if (!rows.length) {
    throw new ConversationOriginUnresolvedError()
  }
  return rows.map((row) => {
    if (typeof row.origin_json !== 'string' || typeof row.atom_path !== 'string') {
      throw new ConversationOriginUnresolvedError()
    }
    const origin = parseConversationOrigin(JSON.parse(row.origin_json))
    assertConversationOrigin(db, source.sessionId, origin)
    return { atomPath: row.atom_path, origin }
  })
}
