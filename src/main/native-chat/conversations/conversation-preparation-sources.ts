import { ConversationPreparationStaleError } from './conversation-preparation-stale'
import { readConversationSourceProvenance } from './conversation-source-provenance-revision'
import { createHash, randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { z } from 'zod'
import type Database from '../../sqlite/sync-database'
import type { ConversationSwitchIntent } from '../../../shared/conversation-record'
import { runJournalTransaction } from '../agent-session-journal/journal-transaction'
import {
  pinJournalEpoch,
  releaseJournalEpochPins
} from '../agent-session-journal/journal-epoch-pins'
import {
  readConversation,
  readConversationDeliverySources,
  readSwitchIntent
} from './conversation-read-model'
import { conversationContextDigest } from './conversation-context-consent'
import { conversationEvidenceKey } from './conversation-context-evidence'
import { assertConversationOriginsResolved } from './conversation-origin-rows'
import { prepareConversationOriginSourceAtomReceipt } from './conversation-origin-source-atoms'
import {
  scanConversationPreparationSources,
  type ConversationPreparationSourceRow
} from './conversation-preparation-source-reader'

const digest = z.string().regex(/^[a-f0-9]{64}$/),
  positive = z.number().int().positive()
const sourceSchema = z.object({
  ownerId: z.string().min(1),
  operationKey: z.string().min(1),
  intentVersion: positive,
  conversationId: z.string().min(1),
  targetSessionId: z.string().min(1),
  sourceProvenance: z.array(
    z.object({ sessionId: z.string().min(1), revision: z.number().int().nonnegative() })
  ),
  contextGeneration: positive,
  sourceRevision: digest,
  attributionDigest: digest,
  boundaries: z.array(
    z.object({ sessionId: z.string().min(1), epoch: z.string().min(1), endSequence: positive })
  ),
  enumeration: z.object({
    sourceCount: z.number().int().nonnegative(),
    orderedVersionDigest: digest
  })
})
export type ConversationPreparationSources = z.infer<typeof sourceSchema>
const MAX_HEADER_BYTES = 1024 * 1024

/** Bounded durable header read only; no canonical payload scans in an activation transaction. */
export function readConversationPreparationSources(
  db: Database.Database,
  ownerId: string
): ConversationPreparationSources | null {
  const length = db
    .prepare(
      'SELECT octet_length(record_json) bytes FROM conversation_preparation_sources WHERE owner_id=?'
    )
    .get(ownerId)?.bytes
  if (length === undefined) {
    return null
  }
  if (typeof length !== 'number' || length > MAX_HEADER_BYTES) {
    throw new Error('Preparation header resource limit')
  }
  const row = db
    .prepare(
      'SELECT operation_key,record_json FROM conversation_preparation_sources WHERE owner_id=?'
    )
    .get(ownerId)
  const snapshot = sourceSchema.parse(JSON.parse(String(row?.record_json)))
  if (
    snapshot.ownerId !== ownerId ||
    snapshot.operationKey !== row?.operation_key ||
    conversationContextDigest(snapshot.boundaries) !== snapshot.sourceRevision
  ) {
    throw new Error('Invalid preparation header')
  }
  if (
    readConversation(db, snapshot.conversationId)?.contextGeneration !==
      snapshot.contextGeneration ||
    conversationContextDigest(
      readConversationSourceProvenance(db, snapshot.conversationId, snapshot.targetSessionId)
    ) !== conversationContextDigest(snapshot.sourceProvenance)
  ) {
    throw new ConversationPreparationStaleError('Preparation provenance changed')
  }
  for (const boundary of snapshot.boundaries) {
    const pin = db
      .prepare(
        'SELECT end_sequence FROM journal_epoch_pins WHERE owner_id=? AND session_id=? AND epoch=?'
      )
      .get(ownerId, boundary.sessionId, boundary.epoch)
    if (pin?.end_sequence !== boundary.endSequence) {
      throw new Error('Preparation pin missing')
    }
  }
  return snapshot
}
function digests() {
  const versions = createHash('sha256'),
    origins = createHash('sha256')
  let sourceCount = 0
  return {
    add(row: ConversationPreparationSourceRow) {
      const key = conversationEvidenceKey(row.version)
      versions.update(key).update('\n')
      origins.update(key).update(row.attributionDigest).update('\n')
      sourceCount++
    },
    end() {
      return {
        enumeration: { sourceCount, orderedVersionDigest: versions.digest('hex') },
        attributionDigest: origins.digest('hex')
      }
    }
  }
}
/** Independent exact source traversal. Consumer must exhaust it before publishing compiled output. */
export async function* readConversationPreparationSourceRows(
  db: Database.Database,
  ownerId: string,
  signal: AbortSignal
): AsyncGenerator<ConversationPreparationSourceRow> {
  if (db.isTransaction) {
    throw new Error('Preparation cannot wait in a writer transaction')
  }
  const snapshot = readConversationPreparationSources(db, ownerId)
  if (!snapshot) {
    throw new Error('Preparation snapshot missing')
  }
  const assertLive = () => {
    const intent = readSwitchIntent(db, snapshot.operationKey)
    if (
      !intent ||
      intent.contextGeneration !== snapshot.contextGeneration ||
      readConversation(db, snapshot.conversationId)?.contextGeneration !==
        snapshot.contextGeneration ||
      conversationContextDigest(
        readConversationDeliverySources(db, snapshot.conversationId, intent.targetSessionId)
      ) !== snapshot.sourceRevision
    ) {
      throw new ConversationPreparationStaleError('Preparation source changed')
    }
  }
  assertLive()
  const hashes = digests()
  for await (const row of scanConversationPreparationSources(db, snapshot, signal)) {
    hashes.add(row)
    yield row
  }
  const actual = hashes.end()
  if (
    conversationContextDigest(actual.enumeration) !==
      conversationContextDigest(snapshot.enumeration) ||
    actual.attributionDigest !== snapshot.attributionDigest
  ) {
    throw new Error('Preparation source integrity changed')
  }
  readConversationPreparationSources(db, ownerId)
  assertLive()
}
/** Pins preserve reducer prefixes; enumeration only includes proven current-generation facts. */
export async function freezeConversationPreparationSources(
  db: Database.Database,
  intent: ConversationSwitchIntent,
  signal: AbortSignal
): Promise<ConversationPreparationSources> {
  if (db.isTransaction) {
    throw new Error('Preparation cannot wait in a writer transaction')
  }
  signal.throwIfAborted()
  const ownerId = `conversation-preparation:${randomUUID()}`
  const readBoundaries = () =>
    readConversationDeliverySources(db, intent.conversationId, intent.targetSessionId)
  const boundaries = readBoundaries(),
    sourceRevision = conversationContextDigest(boundaries)
  const assertCurrent = () => {
    const current = readSwitchIntent(db, intent.operationKey)
    if (
      !current ||
      current.conversationId !== intent.conversationId ||
      current.targetSessionId !== intent.targetSessionId ||
      current.version !== intent.version ||
      current.contextGeneration !== intent.contextGeneration ||
      (current.phase !== 'quiescing' && current.phase !== 'prepared') ||
      conversationContextDigest(readBoundaries()) !== sourceRevision
    ) {
      throw new ConversationPreparationStaleError('Preparation source changed')
    }
    assertConversationOriginsResolved(db, intent.conversationId, intent.contextGeneration)
  }
  let published = false
  try {
    runJournalTransaction(db, () => {
      assertCurrent()
      for (const boundary of boundaries) {
        pinJournalEpoch(db, { ownerId, ...boundary })
      }
    })
    const hashes = digests()
    const scope = {
      ownerId,
      conversationId: intent.conversationId,
      contextGeneration: intent.contextGeneration,
      targetSessionId: intent.targetSessionId,
      sourceProvenance: readConversationSourceProvenance(
        db,
        intent.conversationId,
        intent.targetSessionId
      ),
      boundaries
    }
    const assertProvenance = () => {
      if (
        conversationContextDigest(
          readConversationSourceProvenance(db, intent.conversationId, intent.targetSessionId)
        ) !== conversationContextDigest(scope.sourceProvenance)
      ) {
        throw new ConversationPreparationStaleError('Preparation provenance changed')
      }
    }
    for await (const row of scanConversationPreparationSources(db, scope, signal)) {
      if (row.kind === 'lifecycle-batch') {
        const source = row.version.source
        const boundary = boundaries.find(
          (value) => value.sessionId === source.sessionId && value.epoch === source.epoch
        )
        if (!boundary) {
          throw new Error('Preparation pin missing')
        }
        const receipt = prepareConversationOriginSourceAtomReceipt(db, {
          pin: { ownerId, ...boundary },
          source,
          conversationId: intent.conversationId,
          contextGeneration: intent.contextGeneration,
          mutationCount: row.mutationCount
        })
        if (receipt) {
          runJournalTransaction(db, () => {
            assertCurrent()
            assertProvenance()
            receipt.write(db)
            assertProvenance()
          })
          receipt.committed()
        }
      }
      hashes.add(row)
    }
    await setImmediate(undefined, { signal })
    const snapshot: ConversationPreparationSources = {
      ...scope,
      operationKey: intent.operationKey,
      intentVersion: intent.version,
      sourceRevision,
      ...hashes.end()
    }
    const json = JSON.stringify(sourceSchema.parse(snapshot))
    if (Buffer.byteLength(json) > MAX_HEADER_BYTES) {
      throw new Error('Preparation header resource limit')
    }
    runJournalTransaction(db, () => {
      assertCurrent()
      assertProvenance()
      db.prepare('INSERT INTO conversation_preparation_sources VALUES(?,?,?)').run(
        ownerId,
        intent.operationKey,
        json
      )
    })
    published = true
    return snapshot
  } finally {
    if (!published) {
      runJournalTransaction(db, () => releaseJournalEpochPins(db, ownerId))
    }
  }
}
