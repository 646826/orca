export function createConversationSourceAtomTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS conversation_source_versions (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  row_kind TEXT NOT NULL,
  mutation_count INTEGER NOT NULL,
  PRIMARY KEY(session_id,epoch,sequence)
);
CREATE TABLE IF NOT EXISTS conversation_source_atoms (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  atom_path TEXT NOT NULL,
  segment_id TEXT NOT NULL REFERENCES conversation_segments(segment_id),
  context_generation INTEGER NOT NULL,
  native_binding_generation INTEGER NOT NULL,
  row_sha256 TEXT NOT NULL,
  mutation_count INTEGER NOT NULL,
  item_id TEXT,
  item_revision INTEGER,
  PRIMARY KEY(session_id,epoch,sequence,atom_path)
);
`
}
