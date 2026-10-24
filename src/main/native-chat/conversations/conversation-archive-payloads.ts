import type Database from '../../sqlite/sync-database'

/** Erase only derived payloads of the tombstoned generation; immutable audit IDs/digests remain. */
export function pruneConversationArchivePayloads(
  db: Database.Database,
  operationKey: string
): boolean {
  if (!db.isTransaction) {
    throw new Error('Archive payload cleanup requires transaction')
  }
  const job = db
    .prepare(
      'SELECT conversation_id,context_generation FROM conversation_archive_deletions WHERE operation_key=?'
    )
    .get(operationKey)
  if (!job) {
    throw new Error('Missing archive tombstone')
  }
  const audit = (kind: string, id: string, metadata: unknown) => {
    const serialized = JSON.stringify(metadata)
    const existing = db
      .prepare(
        'SELECT metadata_json FROM conversation_archive_audit WHERE operation_key=? AND kind=? AND evidence_id=?'
      )
      .get(operationKey, kind, id)
    if (existing) {
      if (existing.metadata_json !== serialized) {
        throw new Error('Archive audit identity changed')
      }
      return
    }
    db.prepare('INSERT INTO conversation_archive_audit VALUES(?,?,?,?)').run(
      operationKey,
      kind,
      id,
      serialized
    )
  }
  const preview = db
    .prepare(
      "SELECT manifest_id,json_extract(manifest_json,'$.digest') digest FROM conversation_preparation_previews WHERE json_extract(manifest_json,'$.conversationId')=? AND json_extract(manifest_json,'$.contextGeneration')=? LIMIT 1"
    )
    .get(job.conversation_id, job.context_generation)
  if (typeof preview?.manifest_id === 'string') {
    audit('preview', preview.manifest_id, { digest: preview.digest })
    db.prepare('DELETE FROM conversation_preparation_consents WHERE manifest_id=?').run(
      preview.manifest_id
    )
    db.prepare('DELETE FROM conversation_preparation_previews WHERE manifest_id=?').run(
      preview.manifest_id
    )
    return false
  }
  const manifest = db
    .prepare(
      "SELECT manifest_id,json_extract(manifest_json,'$.digest') digest FROM conversation_context_manifests WHERE json_extract(manifest_json,'$.conversationId')=? AND json_extract(manifest_json,'$.contextGeneration')=? LIMIT 1"
    )
    .get(job.conversation_id, job.context_generation)
  if (typeof manifest?.manifest_id === 'string') {
    const id = manifest.manifest_id
    audit('manifest', id, { digest: manifest.digest })
    db.prepare(
      'DELETE FROM conversation_context_coverage WHERE rowid IN (SELECT rowid FROM conversation_context_coverage WHERE manifest_id=? LIMIT 128)'
    ).run(id)
    if (
      db.prepare('SELECT 1 FROM conversation_context_coverage WHERE manifest_id=? LIMIT 1').get(id)
    ) {
      return false
    }
    const indexed = db
      .prepare(
        'SELECT receipt_id,root_digest,part_count FROM conversation_context_index_receipts WHERE manifest_id=? LIMIT 128'
      )
      .all(id)
    for (const receipt of indexed) {
      if (typeof receipt.receipt_id !== 'string') {
        throw new Error('Invalid archived coverage receipt')
      }
      audit('coverage', receipt.receipt_id, {
        manifestId: id,
        rootDigest: receipt.root_digest,
        partCount: receipt.part_count
      })
      db.prepare(
        'DELETE FROM conversation_context_index_receipts WHERE manifest_id=? AND receipt_id=?'
      ).run(id, receipt.receipt_id)
    }
    if (indexed.length === 128) {
      return false
    }
    const plan = db
      .prepare('SELECT plan_id FROM conversation_delivery_plans WHERE manifest_id=? LIMIT 1')
      .get(id)
    if (typeof plan?.plan_id === 'string') {
      const receipts = db
        .prepare('SELECT receipt_id FROM conversation_delivery_receipts WHERE plan_id=? LIMIT 128')
        .all(plan.plan_id)
      for (const receipt of receipts) {
        if (typeof receipt.receipt_id !== 'string') {
          throw new Error('Invalid archived delivery receipt')
        }
        audit('delivery', receipt.receipt_id, {
          manifestId: id,
          manifestDigest: manifest.digest,
          planId: plan.plan_id
        })
        db.prepare('DELETE FROM conversation_delivery_receipts WHERE receipt_id=?').run(
          receipt.receipt_id
        )
      }
      if (receipts.length === 128) {
        return false
      }
      db.prepare('DELETE FROM conversation_delivery_inputs WHERE plan_id=?').run(plan.plan_id)
      db.prepare('DELETE FROM conversation_delivery_plans WHERE plan_id=?').run(plan.plan_id)
      return false
    }
    db.prepare('DELETE FROM conversation_manifest_index_authorizations WHERE manifest_id=?').run(id)
    db.prepare('DELETE FROM conversation_context_manifests WHERE manifest_id=?').run(id)
    return false
  }
  const index = db
    .prepare(
      'SELECT index_id,root_digest,part_count FROM conversation_manifest_part_indexes i WHERE conversation_id=? AND context_generation=? AND EXISTS(SELECT 1 FROM conversation_manifest_parts p WHERE p.index_id=i.index_id) LIMIT 1'
    )
    .get(job.conversation_id, job.context_generation)
  if (typeof index?.index_id === 'string') {
    audit('index', index.index_id, { rootDigest: index.root_digest, partCount: index.part_count })
    // The tombstone revokes compilation authority before any sealed part is removed.
    db.prepare('DELETE FROM conversation_manifest_compilations WHERE index_id=?').run(
      index.index_id
    )
    db.prepare('DELETE FROM conversation_manifest_index_authorizations WHERE index_id=?').run(
      index.index_id
    )
    db.prepare(
      'DELETE FROM conversation_manifest_parts WHERE index_id=? AND ordinal IN (SELECT ordinal FROM conversation_manifest_parts WHERE index_id=? ORDER BY ordinal LIMIT 128)'
    ).run(index.index_id, index.index_id)
    return false
  }
  return true
}
