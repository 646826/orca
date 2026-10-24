import type Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { readAgentJournalMessageBody } from '../../../shared/agent-session-journal-body-admission'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { QueueOrderSchema } from './queued-message-evidence'

/** Import is historical evidence, never admission into the participant's current generation. */
export function preserveLegacyQueuedMessageEvidence(
  db: Database.Database,
  sessionId: string,
  messageId: string,
  reservation?: { ownerId: string; expectedFingerprint: string }
): void {
  if (!db.isTransaction) {
    throw new Error('legacy queued evidence requires transaction')
  }
  const legacy = db
    .prepare(`SELECT created_at,position,queued_epoch,queued_sequence,
    CASE WHEN octet_length(body_json)+COALESCE(octet_length(options_json),0)<=1048576 THEN body_json END body_json,
    CASE WHEN octet_length(body_json)+COALESCE(octet_length(options_json),0)<=1048576 THEN options_json END options_json
    FROM queued_messages WHERE session_id=? AND message_id=?`)
    .get(sessionId, messageId)
  if (!legacy) {
    return
  }
  if (typeof legacy.body_json !== 'string') {
    throw new Error('legacy queued evidence exceeds bound')
  }
  if (
    !db
      .prepare('SELECT 1 FROM queued_message_origins WHERE session_id=? AND message_id=?')
      .get(sessionId, messageId)
  ) {
    db.prepare(
      'INSERT INTO queued_message_origins(session_id,message_id,origin_json,admitted_at) VALUES(?,?,NULL,?)'
    ).run(sessionId, messageId, legacy.created_at)
  }
  const parsed: unknown = JSON.parse(String(legacy.body_json))
  if (readAgentJournalMessageBody(parsed) !== 'readable') {
    throw new Error('legacy queued evidence unreadable')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: admitted by the full journal message validator above.
  const body = parsed as AgentJournalMessageItem
  const fingerprint = agentSessionSendBodyFingerprint(sessionId, body)
  if (reservation && reservation.expectedFingerprint !== fingerprint) {
    throw new Error('legacy queued original changed')
  }
  const reservations = db
    .prepare(
      "SELECT transfer_id,json_extract(binding_json,'$.sourceFingerprint') fingerprint FROM conversation_trigger_reservations WHERE queue_session_id=? AND message_id=? AND state!='cancelled'"
    )
    .all(sessionId, messageId)
  if (!reservations.length && !reservation) {
    return
  }
  if (
    !db
      .prepare(
        'SELECT 1 FROM queued_message_evidence WHERE session_id=? AND message_id=? AND fingerprint=?'
      )
      .get(sessionId, messageId, fingerprint)
  ) {
    db.prepare('INSERT INTO queued_message_evidence VALUES(?,?,?,?,?,?,NULL,NULL)').run(
      sessionId,
      messageId,
      fingerprint,
      reservations.length || reservation ? legacy.body_json : null,
      legacy.options_json,
      legacy.created_at
    )
  }
  const queueOrder = QueueOrderSchema.parse({
    position: legacy.position,
    queuedAt:
      typeof legacy.queued_epoch === 'string' && typeof legacy.queued_sequence === 'number'
        ? { epoch: legacy.queued_epoch, sequence: legacy.queued_sequence }
        : null
  })
  const own = (ownerId: string) => {
    const prior = db
      .prepare(
        'SELECT session_id,message_id,fingerprint FROM queued_message_evidence_owners WHERE owner_id=?'
      )
      .get(ownerId)
    if (
      prior &&
      (prior.session_id !== sessionId ||
        prior.message_id !== messageId ||
        prior.fingerprint !== fingerprint)
    ) {
      throw new Error('legacy queued owner changed')
    }
    if (!prior) {
      db.prepare('INSERT INTO queued_message_evidence_owners VALUES(?,?,?,?,NULL,NULL,?)').run(
        ownerId,
        sessionId,
        messageId,
        fingerprint,
        JSON.stringify(queueOrder)
      )
    }
  }
  if (reservation) {
    own(reservation.ownerId)
  }
  for (const reservation of reservations) {
    if (reservation.fingerprint !== fingerprint) {
      throw new Error('legacy reservation source changed')
    }
    if (typeof reservation.transfer_id !== 'string' || reservation.transfer_id.length === 0) {
      throw new Error('invalid legacy reservation transfer id')
    }
    own(`conversation-transfer:${reservation.transfer_id}`)
  }
}
