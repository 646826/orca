export function createConversationTransferRecoveryTablesSql(): string {
  return `CREATE TABLE IF NOT EXISTS conversation_transfer_recoveries (
    transfer_id TEXT PRIMARY KEY REFERENCES conversation_trigger_reservations(transfer_id),
    caller_key TEXT NOT NULL, client_operation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL, proof_digest TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('return-held-draft','cancel-retain')),
    result_json TEXT NOT NULL CHECK(octet_length(result_json)<=8192),
    proof_json TEXT NOT NULL CHECK(octet_length(proof_json)<=32768),
    retirement_epoch TEXT NOT NULL, retirement_sequence INTEGER NOT NULL,
    UNIQUE(caller_key,client_operation_id));
    CREATE INDEX IF NOT EXISTS conversation_transfer_intentions_by_conversation
    ON conversation_trigger_reservations(json_extract(binding_json,'$.conversationId'));
    CREATE TRIGGER IF NOT EXISTS conversation_transfer_recoveries_immutable
    BEFORE UPDATE ON conversation_transfer_recoveries
    BEGIN SELECT RAISE(ABORT,'transfer recovery receipt is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS conversation_transfer_recoveries_no_replace
    BEFORE INSERT ON conversation_transfer_recoveries
    WHEN EXISTS(SELECT 1 FROM conversation_transfer_recoveries WHERE transfer_id=NEW.transfer_id)
    BEGIN SELECT RAISE(ABORT,'transfer recovery receipt cannot be replaced'); END;`
}
