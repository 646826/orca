import type * as ClaudeAgentSdk from '@anthropic-ai/claude-agent-sdk'
/**
 * The SDK is loaded at the structured-Claude boundary rather than by this module's
 * import. The ordinary runtime's class graph statically reaches this file, and the
 * SDK sets `process.env.NoDefaultCurrentDirectoryInExePath` at import time — a
 * Windows executable-search change that a user who never leaves the terminal/TUI
 * path never opted into, and a missing SDK would fail runtime startup. Memoized,
 * so a session pays the import once per process rather than once per connection.
 */

let claudeAgentSdk: Promise<typeof ClaudeAgentSdk> | null = null

export function loadClaudeAgentSdk(): Promise<typeof ClaudeAgentSdk> {
  claudeAgentSdk ??= import('@anthropic-ai/claude-agent-sdk')
  return claudeAgentSdk
}
