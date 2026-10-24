import { z } from 'zod'
import type Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { readAgentJournalMessageBody } from '../../../shared/agent-session-journal-body-admission'
import {
  readAgentSessionExecutionOptions,
  type AgentSessionExecutionOptions
} from '../../../shared/agent-session-execution-options'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { conversationContextDigest } from '../conversations/conversation-context-consent'
import { OriginSchema, type QueuedDraftOrigin } from './queued-message-origin-schema'
import type { JournalRow } from './journal-row-schema'

export const QueueOrderSchema = z.object({
  position: z.number().finite(),
  queuedAt: z
    .object({ epoch: z.string().min(1), sequence: z.number().int().nonnegative() })
    .nullable()
})
export type QueuedMessageOrder = z.infer<typeof QueueOrderSchema>
export type QueuedMessageEvidence = {
  queueOrder?: QueuedMessageOrder
  sourceSessionId: string
  messageId: string
  fingerprint: string
  body: AgentJournalMessageItem
  options?: AgentSessionExecutionOptions
  admittedAt: number | null
  source: { epoch: string; sequence: number } | null
  origin: QueuedDraftOrigin | null
}

export function readQueuedMessageEvidence(
  db: Database.Database,
  input: {
    sourceSessionId: string
    messageId: string
    fingerprint: string
    maxBytes?: number
    source?: { epoch: string; sequence: number } | null
  }
): QueuedMessageEvidence | null {
  const bound = input.maxBytes ?? 1024 * 1024
  if (!Number.isSafeInteger(bound) || bound < 1 || bound > 16 * 1024 * 1024) {
    throw new Error('invalid queued evidence bound')
  }
  const saved = db
    .prepare(`SELECT e.admitted_at,
    CASE WHEN COALESCE(octet_length(e.body_json),0)+COALESCE(octet_length(e.options_json),0)<=? THEN e.options_json END options_json,
    CASE WHEN octet_length(o.origin_json)<=16384 THEN o.origin_json END origin_json,
    COALESCE(octet_length(e.body_json),0)+COALESCE(octet_length(e.options_json),0) proof_bytes,
    CASE WHEN COALESCE(octet_length(e.body_json),0)+COALESCE(octet_length(e.options_json),0)<=? THEN e.body_json END body_json
    FROM queued_message_evidence e LEFT JOIN queued_message_origins o USING(session_id,message_id)
    WHERE e.session_id=? AND e.message_id=? AND e.fingerprint=?`)
    .get(bound, bound, input.sourceSessionId, input.messageId, input.fingerprint)
  if (!saved) {
    return null
  }
  if (typeof saved.proof_bytes !== 'number' || saved.proof_bytes > bound) {
    throw new Error('queued evidence exceeds bound')
  }
  const source =
    input.source === null
      ? undefined
      : db
          .prepare(`SELECT s.epoch,s.sequence,
    CASE WHEN octet_length(j.row_json)+COALESCE(octet_length(?),0)<=? THEN json_extract(j.row_json,'$.change.body') END body_json
    FROM queued_message_evidence_sources s JOIN journal_rows j
    ON j.session_id=s.session_id AND j.epoch=s.epoch AND j.seq=s.sequence
    WHERE s.session_id=? AND s.message_id=? AND s.fingerprint=?
      AND CASE WHEN octet_length(j.row_json)+COALESCE(octet_length(?),0)<=? THEN
        json_extract(j.row_json,'$.kind')='queue'
        AND json_extract(j.row_json,'$.messageId')=s.message_id
        AND json_extract(j.row_json,'$.change.op') IN ('queued','edited') END
      AND (? IS NULL OR (s.epoch=? AND s.sequence=?)) ORDER BY s.rowid DESC LIMIT 1`)
          .get(
            saved.options_json,
            bound,
            input.sourceSessionId,
            input.messageId,
            input.fingerprint,
            saved.options_json,
            bound,
            input.source?.epoch ?? null,
            input.source?.epoch ?? null,
            input.source?.sequence ?? null
          )
  if (input.source && !source) {
    throw new Error('pinned queued source missing')
  }
  const raw = source ? source.body_json : saved.body_json
  if (typeof raw !== 'string') {
    throw new Error('queued evidence unavailable or exceeds bound')
  }
  const body: unknown = JSON.parse(raw)
  if (readAgentJournalMessageBody(body) !== 'readable') {
    throw new Error('queued evidence body changed')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: admitted by the full journal message validator above.
  const message = body as AgentJournalMessageItem
  if (agentSessionSendBodyFingerprint(input.sourceSessionId, message) !== input.fingerprint) {
    throw new Error('queued evidence body changed')
  }
  const options =
    saved.options_json === null
      ? undefined
      : readAgentSessionExecutionOptions(JSON.parse(String(saved.options_json)))
  if (options === null) {
    throw new Error('queued evidence options changed')
  }
  return {
    sourceSessionId: input.sourceSessionId,
    messageId: input.messageId,
    fingerprint: input.fingerprint,
    body: message,
    ...(options ? { options } : {}),
    admittedAt: typeof saved.admitted_at === 'number' ? saved.admitted_at : null,
    source:
      typeof source?.epoch === 'string' && typeof source.sequence === 'number'
        ? { epoch: source.epoch, sequence: source.sequence }
        : null,
    origin:
      typeof saved.origin_json === 'string'
        ? OriginSchema.parse(JSON.parse(saved.origin_json))
        : null
  }
}

/** Mandatory row metadata, written after operation receipts and before conversation attribution. */
export function captureQueuedJournalRowEvidence(
  db: Database.Database,
  sessionId: string,
  row: JournalRow
): void {
  if (row.kind !== 'queue') {
    return
  }
  if (!db.isTransaction) {
    throw new Error('queued evidence requires transaction')
  }
  const origin = db
    .prepare('SELECT admitted_at FROM queued_message_origins WHERE session_id=? AND message_id=?')
    .get(sessionId, row.messageId)
  if (!origin) {
    db.prepare(
      'INSERT INTO queued_message_origins(session_id,message_id,origin_json) VALUES(?,?,NULL)'
    ).run(sessionId, row.messageId)
  }
  if (row.change.op !== 'queued' && row.change.op !== 'edited') {
    return
  }
  const fingerprint = agentSessionSendBodyFingerprint(sessionId, row.change.body)
  db.prepare('INSERT INTO queued_message_evidence_sources VALUES(?,?,?,?,?)').run(
    sessionId,
    row.messageId,
    fingerprint,
    row.epoch,
    row.seq
  )
  const optionsJson =
    row.change.op === 'queued'
      ? row.change.options
        ? JSON.stringify(row.change.options)
        : null
      : (db
          .prepare(
            'SELECT options_json FROM queued_message_evidence WHERE session_id=? AND message_id=? ORDER BY rowid DESC LIMIT 1'
          )
          .get(sessionId, row.messageId)?.options_json ?? null)
  const existing = db
    .prepare(
      'SELECT options_json FROM queued_message_evidence WHERE session_id=? AND message_id=? AND fingerprint=?'
    )
    .get(sessionId, row.messageId, fingerprint)
  if (existing) {
    if (
      conversationContextDigest(JSON.parse(String(existing.options_json ?? 'null'))) !==
      conversationContextDigest(JSON.parse(String(optionsJson ?? 'null')))
    ) {
      throw new Error('queued evidence options changed')
    }
  } else {
    db.prepare('INSERT INTO queued_message_evidence VALUES(?,?,?,?,?,?,?,?)').run(
      sessionId,
      row.messageId,
      fingerprint,
      null,
      optionsJson,
      origin?.admitted_at ?? null,
      row.epoch,
      row.seq
    )
  }
}
