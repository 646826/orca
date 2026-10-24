import type Database from '../../sqlite/sync-database'

/** Archive ownership is released with its epoch pins, including legacy originals with no row. */
export function releaseQueuedMessageEvidence(db: Database.Database, ownerId: string): void {
  if (!db.isTransaction) {
    throw new Error('queued evidence release requires transaction')
  }
  const owned = db
    .prepare(
      'SELECT session_id,message_id,fingerprint FROM queued_message_evidence_owners WHERE owner_id=?'
    )
    .all(ownerId)
  db.prepare('DELETE FROM queued_message_evidence_owners WHERE owner_id=?').run(ownerId)
  const remove =
    db.prepare(`DELETE FROM queued_message_evidence WHERE session_id=? AND message_id=? AND fingerprint=?
    AND NOT EXISTS(SELECT 1 FROM queued_message_evidence_sources s WHERE s.session_id=queued_message_evidence.session_id AND s.message_id=queued_message_evidence.message_id AND s.fingerprint=queued_message_evidence.fingerprint)
    AND NOT EXISTS(SELECT 1 FROM queued_message_evidence_owners o WHERE o.session_id=queued_message_evidence.session_id AND o.message_id=queued_message_evidence.message_id AND o.fingerprint=queued_message_evidence.fingerprint)`)
  for (const row of owned) {
    remove.run(row.session_id, row.message_id, row.fingerprint)
  }
}
