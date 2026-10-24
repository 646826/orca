/** Exact persisted ownership relationships, never wildcard owner-prefix deletion.
 * Participant/acquisition pins are intentionally shared across generations and are not released.
 */
export const CONVERSATION_ARCHIVE_OWNERS = `WITH owners(owner_id,conversation_id,generation) AS (
 SELECT 'conversation-segment:'||segment_id||':initial',conversation_id,json_extract(record_json,'$.contextGeneration') FROM conversation_segments
 UNION SELECT 'conversation-segment:'||segment_id||':sealed',conversation_id,json_extract(record_json,'$.contextGeneration') FROM conversation_segments
 UNION SELECT 'conversation-source:'||segment_id,conversation_id,json_extract(record_json,'$.contextGeneration') FROM conversation_segments
 UNION SELECT 'conversation-enrollment:'||segment_id,conversation_id,json_extract(record_json,'$.contextGeneration') FROM conversation_segments
 UNION SELECT 'conversation-manifest:'||manifest_id,json_extract(manifest_json,'$.conversationId'),json_extract(manifest_json,'$.contextGeneration') FROM conversation_context_manifests
 UNION SELECT owner_id,conversation_id,context_generation FROM conversation_manifest_index_retention JOIN conversation_manifest_part_indexes USING(index_id)
 UNION SELECT owner_id,json_extract(record_json,'$.conversationId'),json_extract(record_json,'$.contextGeneration') FROM conversation_preparation_sources
 UNION SELECT owner_id,conversation_id,context_generation FROM conversation_export_sources
 UNION SELECT owner_id,conversation_id,context_generation FROM conversation_export_disclosures
 UNION SELECT 'conversation-transfer:'||transfer_id,json_extract(binding_json,'$.conversationId'),json_extract(binding_json,'$.contextGeneration') FROM conversation_trigger_reservations
 UNION SELECT 'conversation-no-write:'||n.transfer_id||':'||n.recovery_attempt,json_extract(r.binding_json,'$.conversationId'),json_extract(r.binding_json,'$.contextGeneration') FROM conversation_transfer_no_write n JOIN conversation_trigger_reservations r USING(transfer_id)
 UNION SELECT 'conversation-switch:'||operation_key||':candidate',conversation_id,json_extract(record_json,'$.contextGeneration') FROM conversation_switch_intents
 UNION SELECT p.owner_id,s.conversation_id,json_extract(s.record_json,'$.contextGeneration') FROM conversation_switch_intents s JOIN journal_epoch_pins p
 ON p.owner_id='conversation-switch:'||s.operation_key||':'||CAST(CAST(substr(CAST(p.owner_id AS BLOB),length(CAST('conversation-switch:'||s.operation_key||':' AS BLOB))+1) AS INTEGER) AS TEXT)
 AND CAST(substr(CAST(p.owner_id AS BLOB),length(CAST('conversation-switch:'||s.operation_key||':' AS BLOB))+1) AS INTEGER) BETWEEN 1 AND json_extract(s.record_json,'$.version')
 UNION SELECT r.retention_owner_id,c.conversation_id,json_extract(c.record_json,'$.contextGeneration') FROM conversation_clear_intents c JOIN conversation_clear_rows r USING(operation_key)
) SELECT DISTINCT owner_id FROM owners WHERE conversation_id=? AND generation=? AND owner_id>? ORDER BY owner_id LIMIT 128`
