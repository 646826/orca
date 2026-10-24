import type Database from '../../sqlite/sync-database'
import { isConversationSegment } from '../../../shared/conversation-record'

export class ConversationOriginUnresolvedError extends Error {
  constructor() {
    super('conversation origin unresolved')
  }
}
export type ConversationOriginScope = Omit<ConversationOrigin, 'segmentId'>
export type ConversationOriginKey = { kind: 'submission' | 'turn' | 'item' | 'event'; id: string }
export type ConversationOrigin = {
  conversationId: string
  segmentId: string
  contextGeneration: number
  nativeBindingGeneration: number
}
export function assertConversationOrigin(
  db: Database.Database,
  sessionId: string,
  origin: ConversationOrigin
): void {
  const row = db
    .prepare('SELECT record_json FROM conversation_segments WHERE segment_id=?')
    .get(origin.segmentId)
  const segment: unknown = typeof row?.record_json === 'string' ? JSON.parse(row.record_json) : null
  if (
    !isConversationSegment(segment) ||
    segment.sessionId !== sessionId ||
    segment.conversationId !== origin.conversationId ||
    segment.contextGeneration !== origin.contextGeneration ||
    segment.nativeBindingGeneration !== origin.nativeBindingGeneration
  ) {
    throw new Error('conversation origin identity mismatch')
  }
}
export function readConversationOrigin(
  db: Database.Database,
  sessionId: string,
  key: ConversationOriginKey,
  nativeBindingGeneration: number
): ConversationOrigin | null {
  const row = db
    .prepare(
      'SELECT origin_json FROM conversation_origin_bindings WHERE session_id=? AND native_binding_generation=? AND key_kind=? AND key_id=?'
    )
    .get(sessionId, nativeBindingGeneration, key.kind, key.id)
  if (!row) {
    return null
  }
  const origin = parseConversationOrigin(JSON.parse(String(row.origin_json)))
  assertConversationOrigin(db, sessionId, origin)
  return origin
}
export function bindConversationOrigin(
  db: Database.Database,
  input: {
    sessionId: string
    key: ConversationOriginKey
    origin: ConversationOrigin
  }
): void {
  if (!db.isTransaction || !input.key.id) {
    throw new Error('conversation origin requires transaction and key')
  }
  assertConversationOrigin(db, input.sessionId, input.origin)
  const prior = readConversationOrigin(
    db,
    input.sessionId,
    input.key,
    input.origin.nativeBindingGeneration
  )
  if (
    prior &&
    (prior.segmentId !== input.origin.segmentId ||
      prior.conversationId !== input.origin.conversationId ||
      prior.contextGeneration !== input.origin.contextGeneration ||
      prior.nativeBindingGeneration !== input.origin.nativeBindingGeneration)
  ) {
    throw new Error('conversation origin cannot be rebound')
  }
  db.prepare('INSERT OR IGNORE INTO conversation_origin_bindings VALUES(?,?,?,?,?)').run(
    input.sessionId,
    input.origin.nativeBindingGeneration,
    input.key.kind,
    input.key.id,
    JSON.stringify(input.origin)
  )
}
export function aliasConversationOrigin(
  db: Database.Database,
  input: {
    sessionId: string
    nativeBindingGeneration: number
    from: ConversationOriginKey
    to: ConversationOriginKey
  }
): void {
  const origin = readConversationOrigin(
    db,
    input.sessionId,
    input.from,
    input.nativeBindingGeneration
  )
  if (!origin) {
    throw new ConversationOriginUnresolvedError()
  }
  bindConversationOrigin(db, { sessionId: input.sessionId, key: input.to, origin })
}

export function parseConversationOrigin(value: unknown): ConversationOrigin {
  if (
    !value ||
    typeof value !== 'object' ||
    !('conversationId' in value) ||
    typeof value.conversationId !== 'string' ||
    !('segmentId' in value) ||
    typeof value.segmentId !== 'string' ||
    !('contextGeneration' in value) ||
    typeof value.contextGeneration !== 'number' ||
    !Number.isSafeInteger(value.contextGeneration) ||
    value.contextGeneration < 1 ||
    !('nativeBindingGeneration' in value) ||
    typeof value.nativeBindingGeneration !== 'number' ||
    !Number.isSafeInteger(value.nativeBindingGeneration) ||
    value.nativeBindingGeneration < 1
  ) {
    throw new Error('corrupt conversation origin')
  }
  return {
    conversationId: value.conversationId,
    segmentId: value.segmentId,
    contextGeneration: value.contextGeneration,
    nativeBindingGeneration: value.nativeBindingGeneration
  }
}
export function parseConversationOriginKeys(value: unknown): ConversationOriginKey[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    throw new Error('corrupt conversation origin keys')
  }
  return value.map((key: unknown) => {
    if (
      !key ||
      typeof key !== 'object' ||
      !('kind' in key) ||
      !('id' in key) ||
      typeof key.id !== 'string' ||
      !key.id ||
      (key.kind !== 'submission' &&
        key.kind !== 'turn' &&
        key.kind !== 'item' &&
        key.kind !== 'event')
    ) {
      throw new Error('corrupt conversation origin key')
    }
    return { kind: key.kind, id: key.id }
  })
}
