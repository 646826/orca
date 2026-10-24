export function createConversationTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  record_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_participants (
  session_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversation_participants_by_conversation ON conversation_participants(conversation_id);
CREATE TABLE IF NOT EXISTS conversation_segments (
  segment_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  ordinal INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  UNIQUE(conversation_id, ordinal)
);
CREATE INDEX IF NOT EXISTS conversation_segments_by_session ON conversation_segments(json_extract(record_json,'$.sessionId'));
CREATE TABLE IF NOT EXISTS conversation_switch_intents (
  operation_key TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  record_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_source_spans (
  segment_id TEXT NOT NULL REFERENCES conversation_segments(segment_id),
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  start_sequence INTEGER NOT NULL,
  end_sequence INTEGER NOT NULL,
  PRIMARY KEY(segment_id, epoch),
  UNIQUE(segment_id, ordinal)
);
CREATE TABLE IF NOT EXISTS conversation_source_attribution (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  segment_id TEXT NOT NULL REFERENCES conversation_segments(segment_id),
  PRIMARY KEY(session_id, epoch, sequence)
);
CREATE INDEX IF NOT EXISTS conversation_sources_by_segment ON conversation_source_attribution(segment_id, sequence);
`
}
