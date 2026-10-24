import { createHash } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import type {
  ConversationEvidenceVersion,
  ConversationContextRepresentation
} from '../../../shared/conversation-handoff'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { agentSessionMessagePayload } from '../../../shared/structured-agent-session-send-mutation'
import { parseJournalRow } from '../agent-session-journal/journal-row-schema'
import { conversationContextDigest } from './conversation-context-consent'
import { assertConversationTransportOrigin } from './conversation-transport-origin'
import {
  readConversationTransportOriginal,
  readConversationTransportSubmissionOriginal,
  MAX_TRANSPORT_ROW_BYTES,
  type ConversationTransportScope
} from './conversation-transport-original'

/** Removes only a host-reserved transport layer; original canonical bytes are never rewritten. */
export function projectConversationTransportRow(
  db: Database.Database,
  scope: ConversationTransportScope,
  version: ConversationEvidenceVersion,
  raw: string
): Pick<ConversationContextRepresentation, 'text' | 'transportProjection'> | null {
  if (
    version.source.batchIndex !== undefined ||
    version.source.itemId !== undefined ||
    version.source.itemRevision !== undefined
  ) {
    throw new Error('Transport projection requires a complete canonical row')
  }
  if (Buffer.byteLength(raw) > MAX_TRANSPORT_ROW_BYTES) {
    const proof = readConversationTransportSubmissionOriginal(db, scope, version.source)
    if (!proof || proof.raw !== raw) {
      return null
    }
  }
  if (createHash('sha256').update(raw).digest('hex') !== version.sha256) {
    throw new Error('Transport projection source changed')
  }
  const parsed = parseJournalRow(raw)
  if (
    !parsed.ok ||
    parsed.row.epoch !== version.source.epoch ||
    parsed.row.seq !== version.source.sequence
  ) {
    throw new Error('Transport projection source is invalid')
  }
  const row = parsed.row
  const projected: unknown = JSON.parse(raw)
  if (!projected || typeof projected !== 'object' || Array.isArray(projected)) {
    throw new Error('Transport projection source is invalid')
  }
  const replaceBlocks = (bodyPath: string, blocks: AgentJournalMessageItem['blocks']) => {
    const parent: unknown =
      bodyPath === '/body'
        ? projected
        : Object.getOwnPropertyDescriptor(projected, 'mutations')?.value?.[
            Number(bodyPath.split('/')[2])
          ]
    if (
      !parent ||
      typeof parent !== 'object' ||
      Array.isArray(parent) ||
      !Object.hasOwn(parent, 'body')
    ) {
      throw new Error('Transport projection body path is invalid')
    }
    const body: unknown = Object.getOwnPropertyDescriptor(parent, 'body')?.value
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Transport projection body path is invalid')
    }
    Object.defineProperty(body, 'blocks', {
      value: blocks,
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
  const transfers: NonNullable<
    ConversationContextRepresentation['transportProjection']
  >['transfers'] = []
  const project = (
    body: AgentJournalMessageItem,
    bodyPath: string,
    submissionId?: string,
    itemId?: string
  ) => {
    const matchId = submissionId ?? itemId
    if (!matchId) {
      throw new Error('Transport projection message identity is unavailable')
    }
    const matches = submissionId
      ? db
          .prepare(
            "SELECT transfer_id FROM conversation_trigger_reservations WHERE target_session_id=? AND target_submission_id=? AND kind='trigger'"
          )
          .all(version.source.sessionId, submissionId)
      : db
          .prepare(`SELECT r.transfer_id,CASE WHEN octet_length(j.row_json)<=? THEN j.row_json END dispatch_json
          FROM conversation_trigger_reservations r JOIN journal_rows j ON j.session_id=r.target_session_id
          WHERE r.target_session_id=? AND r.kind='trigger' AND j.epoch=?
          AND json_extract(j.row_json,'$.kind')='dispatch' AND json_extract(j.row_json,'$.state')='accepted'
          AND json_extract(j.row_json,'$.originCorrelation')='exact'
          AND json_extract(j.row_json,'$.clientMessageId')=r.target_submission_id
          AND json_extract(j.row_json,'$.providerItemId')=? LIMIT 2`)
          .all(MAX_TRANSPORT_ROW_BYTES, version.source.sessionId, version.source.epoch, matchId)
    if (!matches.length) {
      return body
    }
    if (matches.length !== 1 || typeof matches[0]?.transfer_id !== 'string') {
      throw new Error('Transport projection identity is ambiguous')
    }
    const proof = readConversationTransportOriginal(
      db,
      scope,
      version.source.sessionId,
      matches[0].transfer_id
    )
    const atomPath = bodyPath === '/body' ? '$' : `$.mutations[${bodyPath.split('/')[2]}]`
    assertConversationTransportOrigin(
      db,
      version.source,
      row,
      atomPath,
      proof.binding,
      proof.runtimeFence
    )
    if (!submissionId) {
      const dispatch =
        typeof matches[0].dispatch_json === 'string'
          ? parseJournalRow(matches[0].dispatch_json)
          : null
      if (!dispatch?.ok || dispatch.row.kind !== 'dispatch') {
        throw new Error('Transport projection native dispatch is unavailable')
      }
      assertConversationTransportOrigin(
        db,
        {
          sessionId: version.source.sessionId,
          epoch: dispatch.row.epoch,
          sequence: dispatch.row.seq
        },
        dispatch.row,
        '$',
        proof.binding,
        proof.runtimeFence
      )
    }
    if (version.source.epoch !== proof.epoch) {
      throw new Error('Transport projection epoch changed')
    }
    if (
      submissionId &&
      (row.kind !== 'submission' || row.payloadFingerprint !== proof.binding.targetFingerprint)
    ) {
      throw new Error('Transport projection submission changed')
    }
    if (
      conversationContextDigest(agentSessionMessagePayload(body)) !==
      conversationContextDigest(agentSessionMessagePayload(proof.body))
    ) {
      if (
        !submissionId &&
        conversationContextDigest(agentSessionMessagePayload(body)) ===
          conversationContextDigest(agentSessionMessagePayload(proof.original))
      ) {
        return body
      }
      throw new Error('Transport projection body is unverified')
    }
    // Keep native sender/row annotations; only the authenticated transport block is removed.
    replaceBlocks(bodyPath, proof.original.blocks)
    transfers.push({
      transferId: proof.binding.transferId,
      bodyPath,
      bindingDigest: conversationContextDigest(proof.binding)
    })
    return { ...body, blocks: proof.original.blocks }
  }
  if (row.kind === 'submission') {
    row.body = project(row.body, '/body', row.clientMessageId)
  } else if (row.kind === 'item' && row.body.kind === 'message' && row.body.role === 'user') {
    row.body = project(row.body, '/body', undefined, row.itemId)
  } else if (row.kind === 'lifecycle-batch') {
    for (const [index, mutation] of row.mutations.entries()) {
      if (
        mutation.kind === 'item' &&
        mutation.body.kind === 'message' &&
        mutation.body.role === 'user'
      ) {
        mutation.body = project(
          mutation.body,
          `/mutations/${index}/body`,
          undefined,
          mutation.itemId
        )
      }
    }
  }
  const text = JSON.stringify(projected)
  if (transfers.length && Buffer.byteLength(text) > MAX_TRANSPORT_ROW_BYTES) {
    throw new Error('Transport projection exceeds the ordinary row bound')
  }
  return transfers.length ? { text, transportProjection: { transfers } } : null
}

export function verifyConversationTransportProjection(
  db: Database.Database,
  scope: ConversationTransportScope,
  part: ConversationContextRepresentation,
  raw?: string
): boolean {
  if (part.representation !== 'transport-projected' || !part.transportProjection) {
    return false
  }
  try {
    const source = part.version.source
    if (raw === undefined) {
      const proof = readConversationTransportSubmissionOriginal(db, scope, source)
      const stored = db
        .prepare(
          'SELECT CASE WHEN octet_length(row_json)<=? THEN row_json END row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?'
        )
        .get(
          proof?.rowByteLimit ?? MAX_TRANSPORT_ROW_BYTES,
          source.sessionId,
          source.epoch,
          source.sequence
        )
      if (typeof stored?.row_json !== 'string') {
        return false
      }
      raw = stored.row_json
    }
    if (
      part.spans.length !== 1 ||
      conversationContextDigest(part.spans[0].version) !==
        conversationContextDigest(part.version) ||
      part.spans[0].startByte !== 0 ||
      part.spans[0].endByte !== Buffer.byteLength(raw)
    ) {
      return false
    }
    const projected = projectConversationTransportRow(db, scope, part.version, raw)
    return (
      !!projected &&
      projected.text === part.text &&
      conversationContextDigest(projected.transportProjection) ===
        conversationContextDigest(part.transportProjection)
    )
  } catch {
    return false
  }
}
