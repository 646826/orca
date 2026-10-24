import { createHash } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  isAgentSessionProviderHandleLink,
  agentSessionProviderHandleRoot
} from '../../../shared/agent-session-provider-handle'
import { parseConversationOrigin } from './conversation-origin'
import {
  readConversationNativeIdentity,
  readConversationNativeRecord
} from './conversation-origin-native-identity'
import { readConversationFreshCandidateAuthority } from './conversation-pending-native-authority'
import { assertConversationPublishedNativeAuthority } from './conversation-published-native-authority'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const scopeDigest = (record: AgentSessionRecord) =>
  digest({ provider: record.provider, accountHome: record.accountHome, location: record.location })

export function readNativePublicationProof(
  db: Database.Database,
  input: { sessionId: string; operationKey: string },
  allowPublished = false
): { nativeIdentity: string; acquisitionGeneration: string; fence: number } | null {
  const record = readConversationNativeRecord(db, input.sessionId)
  if (!record) {
    return null
  }
  const row = db
    .prepare(
      'SELECT * FROM conversation_pending_native_identity WHERE session_id=? AND fence=? AND operation_key=?'
    )
    .get(input.sessionId, record.lease.runtimeFence, input.operationKey)
  if (
    !row ||
    typeof row.native_identity !== 'string' ||
    typeof row.acquisition_generation !== 'string' ||
    row.initial_chain_json !== '[]' ||
    typeof row.link_json !== 'string' ||
    row.scope_digest !== scopeDigest(record) ||
    row.process_digest !== digest(record.lease.ownerProcess) ||
    record.lease.claimStatus !== 'live' ||
    row.native_identity !== readConversationNativeIdentity(db, input.sessionId)
  ) {
    return null
  }
  const captured = db
    .prepare(
      'SELECT origin_json,native_identity FROM conversation_origin_acquisitions WHERE session_id=? AND fence=?'
    )
    .get(input.sessionId, record.lease.runtimeFence)
  if (
    captured?.origin_json !== row.origin_json ||
    captured.native_identity !== row.native_identity ||
    row.effect_seen !== 0
  ) {
    return null
  }
  try {
    const link: unknown = JSON.parse(row.link_json)
    const first = record.providerHandleChain[0]
    if (
      !isAgentSessionProviderHandleLink(link) ||
      link.origin !== 'created' ||
      link.replaces !== undefined ||
      link.supersedesKey !== undefined ||
      link.mintedAtFence !== record.lease.runtimeFence ||
      !first ||
      first.linkId !== link.linkId ||
      first.origin !== link.origin ||
      first.mintedAtFence !== link.mintedAtFence ||
      agentSessionProviderHandleRoot(first.handle) !== agentSessionProviderHandleRoot(link.handle)
    ) {
      return null
    }
    const origin = parseConversationOrigin(JSON.parse(String(row.origin_json)))
    if (allowPublished) {
      assertConversationPublishedNativeAuthority(db, {
        ...input,
        origin,
        nativeIdentity: row.native_identity,
        fence: record.lease.runtimeFence
      })
    } else if (
      readConversationFreshCandidateAuthority(db, origin, input.sessionId, true).operationKey !==
      input.operationKey
    ) {
      return null
    }
  } catch {
    return null
  }
  return {
    nativeIdentity: row.native_identity,
    acquisitionGeneration: row.acquisition_generation,
    fence: record.lease.runtimeFence
  }
}
