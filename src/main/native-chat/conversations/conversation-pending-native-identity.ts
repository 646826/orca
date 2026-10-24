import { readNativePublicationProof } from './conversation-native-publication-proof'
import { readConversationEnrollmentNativeAuthority } from './conversation-enrollment-native-origin'
import {
  readConversationClearAcquisitionAuthority,
  conversationClearRetainsNativeIdentity,
  conversationClearNativeHistoryKnown
} from './conversation-clear-acquisition-origin'
import { createHash } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionProviderHandleLink } from '../../../shared/agent-session-provider-handle'
import {
  readConversation,
  readSwitchIntent,
  readParticipantSourceBoundaries
} from './conversation-read-model'
import { parseConversationOrigin, type ConversationOrigin } from './conversation-origin'
import {
  readConversationNativeIdentity,
  readConversationNativeRecord
} from './conversation-origin-native-identity'
import {
  readConversationFreshCandidateAuthority,
  readConversationPendingNativeAuthority
} from './conversation-pending-native-authority'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const scopeDigest = (record: AgentSessionRecord) =>
  digest({ provider: record.provider, accountHome: record.accountHome, location: record.location })
/** Called only with the actual pre-owner-proof record, in the same fatal transaction. */
export function prepareConversationPendingNativeIdentity(
  db: Database.Database,
  input: { before: AgentSessionRecord; origin: ConversationOrigin; acquisitionGeneration?: string }
): void {
  if (!db.isTransaction) {
    throw new Error('pending native identity requires transaction')
  }
  if (input.before.providerHandleChain.length !== 0) {
    return
  }
  const conversation = readConversation(db, input.origin.conversationId)
  const intent = conversation?.pendingOperationKey
    ? readSwitchIntent(db, conversation.pendingOperationKey)
    : null
  const clear = readConversationClearAcquisitionAuthority(db, input.before.sessionId)
  const isCandidate =
    intent?.targetSessionId === input.before.sessionId &&
    intent.candidateSegmentId === input.origin.segmentId
  const enrollment =
    !isCandidate && !clear
      ? readConversationEnrollmentNativeAuthority(db, input.before.sessionId)
      : null
  if (!isCandidate && !clear && (!enrollment || !input.acquisitionGeneration)) {
    return
  }
  let operationKey: string
  if (isCandidate) {
    const candidateIntent = readConversationFreshCandidateAuthority(
      db,
      input.origin,
      input.before.sessionId
    )
    if (
      JSON.stringify(readParticipantSourceBoundaries(db, input.before.sessionId)) !==
      JSON.stringify(candidateIntent.candidateBaseline)
    ) {
      throw new Error('pending native candidate evidence changed before owner proof')
    }
    operationKey = candidateIntent.operationKey
  } else if (clear) {
    if (
      JSON.stringify(clear.origin) !== JSON.stringify(input.origin) ||
      clear.record.lease.runtimeFence !== input.before.lease.runtimeFence ||
      scopeDigest(clear.record) !== scopeDigest(input.before) ||
      JSON.stringify(clear.record.providerContextBoundary) !==
        JSON.stringify(input.before.providerContextBoundary)
    ) {
      throw new Error('pending native clear authority changed')
    }
    operationKey = clear.operationKey
  } else {
    if (!enrollment || JSON.stringify(enrollment.origin) !== JSON.stringify(input.origin)) {
      throw new Error('pending native enrollment authority changed')
    }
    operationKey = enrollment.operationKey
  }
  if (!input.acquisitionGeneration || !input.before.lease.ownerProcess) {
    throw new Error('pending native acquisition missing process proof')
  }
  db.prepare(
    'INSERT INTO conversation_pending_native_identity VALUES(?,?,?,?,?,?,?,?,NULL,NULL,0)'
  ).run(
    input.before.sessionId,
    input.before.lease.runtimeFence,
    operationKey,
    JSON.stringify(input.origin),
    input.acquisitionGeneration,
    digest(input.before.lease.ownerProcess),
    scopeDigest(input.before),
    JSON.stringify(input.before.providerHandleChain)
  )
}
/** Publishes only the first created handle; cursor updates and ordinary retained sessions never upgrade NULL. */
export function publishConversationPendingNativeIdentity(
  db: Database.Database,
  input: {
    before: AgentSessionRecord
    after: AgentSessionRecord
    link: AgentSessionProviderHandleLink
    acquisitionGeneration?: string
  }
): void {
  if (!db.isTransaction) {
    throw new Error('pending native identity requires transaction')
  }
  const { before, after, link } = input
  const pending = db
    .prepare('SELECT * FROM conversation_pending_native_identity WHERE session_id=? AND fence=?')
    .get(before.sessionId, before.lease.runtimeFence)
  if (!pending) {
    return
  }
  const origin = parseConversationOrigin(JSON.parse(String(pending.origin_json)))
  const authority = readConversationPendingNativeAuthority(db, origin, before.sessionId)
  if (
    authority.operationKey !== pending.operation_key ||
    pending.acquisition_generation !== input.acquisitionGeneration ||
    pending.process_digest !== digest(before.lease.ownerProcess) ||
    pending.scope_digest !== scopeDigest(before) ||
    scopeDigest(after) !== pending.scope_digest ||
    after.lease.runtimeFence !== before.lease.runtimeFence ||
    after.lease.claimStatus !== 'live' ||
    before.lease.claimStatus !== 'live' ||
    after.lease.ownerProcess === null ||
    digest(after.lease.ownerProcess) !== pending.process_digest ||
    pending.effect_seen !== 0
  ) {
    throw new Error('pending native acquisition proof changed')
  }
  const identity = readConversationNativeIdentity(db, before.sessionId)
  const linkJson = JSON.stringify(link)
  if (pending.native_identity !== null) {
    if (pending.native_identity !== identity || pending.link_json !== linkJson) {
      throw new Error('pending native identity already published differently')
    }
    return
  }
  if (
    before.providerHandleChain.length !== 0 ||
    after.providerHandleChain.length !== 1 ||
    link.origin !== 'created' ||
    link.replaces !== undefined ||
    link.mintedAtFence !== before.lease.runtimeFence ||
    !identity
  ) {
    throw new Error('pending native requires first created link')
  }
  if (
    !conversationClearNativeHistoryKnown(db, origin.conversationId, before.sessionId) ||
    conversationClearRetainsNativeIdentity(db, origin.conversationId, before.sessionId, identity) ||
    db
      .prepare(`SELECT 1 FROM conversation_origin_acquisitions
      WHERE session_id=? AND native_identity=? AND json_extract(origin_json,'$.nativeBindingGeneration')<? LIMIT 1`)
      .get(before.sessionId, identity, origin.nativeBindingGeneration)
  ) {
    throw new Error('cleared native identity cannot be resumed')
  }
  const captured = db
    .prepare(
      'SELECT origin_json,native_identity FROM conversation_origin_acquisitions WHERE session_id=? AND fence=?'
    )
    .get(before.sessionId, before.lease.runtimeFence)
  if (
    captured?.origin_json !== pending.origin_json ||
    (captured.native_identity !== null && captured.native_identity !== identity)
  ) {
    throw new Error('pending native origin changed')
  }
  db.prepare(
    'UPDATE conversation_origin_acquisitions SET native_identity=? WHERE session_id=? AND fence=?'
  ).run(identity, before.sessionId, before.lease.runtimeFence)
  db.prepare(
    'UPDATE conversation_pending_native_identity SET native_identity=?,link_json=? WHERE session_id=? AND fence=? AND native_identity IS NULL'
  ).run(identity, linkJson, before.sessionId, before.lease.runtimeFence)
}

export function readConversationFreshNativeProof(
  db: Database.Database,
  input: { sessionId: string; operationKey: string }
) {
  return readNativePublicationProof(db, input)
}

/** The owner transaction prepared this from its actual pre-proof record, never a caller snapshot. */
export function readConversationPreparedClearNativeOrigin(
  db: Database.Database,
  input: { sessionId: string; fence: number }
) {
  if (!db.isTransaction) {
    return null
  }
  const clear = readConversationClearAcquisitionAuthority(db, input.sessionId)
  if (!clear) {
    return null
  }
  const pending = db
    .prepare('SELECT * FROM conversation_pending_native_identity WHERE session_id=? AND fence=?')
    .get(input.sessionId, input.fence)
  if (
    !pending ||
    pending.operation_key !== clear.operationKey ||
    pending.origin_json !== JSON.stringify(clear.origin) ||
    pending.initial_chain_json !== '[]' ||
    pending.native_identity !== null ||
    pending.effect_seen !== 0 ||
    clear.record.lease.claimStatus !== 'live' ||
    clear.record.lease.runtimeFence !== input.fence ||
    clear.record.lease.ownerProcess === null ||
    pending.process_digest !== digest(clear.record.lease.ownerProcess) ||
    pending.scope_digest !== scopeDigest(clear.record)
  ) {
    return null
  }
  return clear.origin
}

export function assertConversationPendingNativePublished(
  db: Database.Database,
  input: { sessionId: string; fence: number; acquisitionGeneration: string }
): void {
  const record = readConversationNativeRecord(db, input.sessionId)
  if (!record || record.lease.runtimeFence !== input.fence) {
    throw new Error('pending native publication unverified')
  }
  const pending = db
    .prepare(
      'SELECT operation_key FROM conversation_pending_native_identity WHERE session_id=? AND fence=?'
    )
    .get(input.sessionId, input.fence)
  if (!pending) {
    return
  }
  const proof = readNativePublicationProof(
    db,
    {
      sessionId: input.sessionId,
      operationKey: String(pending.operation_key)
    },
    true
  )
  if (
    !proof ||
    proof.acquisitionGeneration !== input.acquisitionGeneration ||
    proof.fence !== input.fence
  ) {
    throw new Error('pending native publication unverified')
  }
}
