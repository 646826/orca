export function createConversationTabSurfaceTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS conversation_tabs (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(conversation_id),
  source_session_id TEXT NOT NULL,
  tab_id TEXT NOT NULL UNIQUE,
  execution_host_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  location_json TEXT NOT NULL,
  visible INTEGER NOT NULL CHECK(visible IN (0,1)),
  surface_revision INTEGER NOT NULL CHECK(surface_revision > 0),
  published_revision INTEGER NOT NULL CHECK(published_revision >= 0 AND published_revision <= surface_revision)
);
CREATE INDEX IF NOT EXISTS conversation_tabs_scope ON conversation_tabs(execution_host_id, workspace_id);
CREATE TRIGGER IF NOT EXISTS conversation_tabs_immutable BEFORE UPDATE ON conversation_tabs
WHEN NEW.conversation_id != OLD.conversation_id OR NEW.source_session_id != OLD.source_session_id
 OR NEW.tab_id != OLD.tab_id OR NEW.location_json != OLD.location_json
 OR NEW.execution_host_id != OLD.execution_host_id OR NEW.workspace_id != OLD.workspace_id
BEGIN SELECT RAISE(ABORT,'conversation surface identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS conversation_tabs_no_replace BEFORE INSERT ON conversation_tabs
WHEN EXISTS(SELECT 1 FROM conversation_tabs WHERE conversation_id=NEW.conversation_id OR tab_id=NEW.tab_id)
BEGIN SELECT RAISE(ABORT,'conversation surface already exists'); END;
CREATE TRIGGER IF NOT EXISTS conversation_tabs_native_collision BEFORE INSERT ON conversation_tabs
WHEN EXISTS(SELECT 1 FROM agent_session_tabs WHERE tab_id=NEW.tab_id)
BEGIN SELECT RAISE(ABORT,'native tab owns conversation surface'); END;
CREATE TRIGGER IF NOT EXISTS agent_session_tabs_conversation_insert BEFORE INSERT ON agent_session_tabs
WHEN EXISTS(SELECT 1 FROM conversation_tabs WHERE tab_id=NEW.tab_id)
BEGIN SELECT RAISE(ABORT,'conversation owns tab'); END;
CREATE TRIGGER IF NOT EXISTS agent_session_tabs_conversation_update BEFORE UPDATE ON agent_session_tabs
WHEN EXISTS(SELECT 1 FROM conversation_tabs WHERE tab_id=NEW.tab_id)
BEGIN SELECT RAISE(ABORT,'conversation owns tab'); END;
`
}
