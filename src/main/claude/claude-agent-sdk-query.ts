import { conversationEvidencePreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-evidence-launch-error'
import type * as ClaudeAgentSdk from '@anthropic-ai/claude-agent-sdk'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import type {
  ClaudeStreamJsonLaunch,
  ClaudeStreamJsonConnectionHandlers
} from './claude-stream-json-connection'
import { loadClaudeAgentSdk } from './claude-agent-sdk-loader'
import {
  createClaudeConversationEvidenceServer,
  CLAUDE_CONVERSATION_EVIDENCE_SERVER
} from './claude-conversation-evidence'
import { createClaudeCodeProcessSpawn } from './claude-agent-sdk-process-spawn'
import { createClaudeUserMessageQueue } from './claude-agent-sdk-user-message-queue'
import { buildClaudeChildProcessEnv } from './claude-child-process-environment'
import { withoutInheritedClaudeConfigDir } from './claude-config-dir-pin'
function withoutKeys(env: Record<string, string>, keys: readonly string[]): Record<string, string> {
  for (const key of keys) {
    delete env[key]
  }
  return env
}

export async function createClaudeStructuredQuery(
  launch: ClaudeStreamJsonLaunch,
  handlers: ClaudeStreamJsonConnectionHandlers,
  spawnImpl: PipedProcessSpawner,
  queryImpl?: typeof ClaudeAgentSdk.query
) {
  const sdk = await loadClaudeAgentSdk()
  const { query } = sdk
  const evidenceServer =
    launch.evidence && createClaudeConversationEvidenceServer(sdk, launch.evidence.registration)
  if (launch.evidence && !launch.evidenceEnv) {
    throw new Error('Approved Claude evidence environment is unavailable')
  }
  const assertEvidence = () => {
    try {
      launch.evidence?.assertBeforeSpawn()
    } catch (error) {
      throw conversationEvidencePreSpawnError(error)
    }
  }
  assertEvidence()
  const spawner = createClaudeCodeProcessSpawn(spawnImpl, process.platform)
  const inbox = createClaudeUserMessageQueue()
  const session = (queryImpl ?? query)({
    prompt: inbox.messages,
    options: {
      ...launch.options,
      ...(evidenceServer
        ? { mcpServers: { [CLAUDE_CONVERSATION_EVIDENCE_SERVER]: evidenceServer } }
        : {}),
      cwd: launch.cwd,
      // Why env is never omitted: the SDK inherits process.env when it is, which is
      // exactly the ambient ANTHROPIC_* auth leak this lane already shipped once.
      // Orca's own CLAUDE_CONFIG_DIR is dropped for the same reason the launch drops the
      // shell's: the record's pin in `launch.env` must be the only home the child sees.
      env:
        launch.evidenceEnv ??
        withoutKeys(
          buildClaudeChildProcessEnv(launch.env, {
            inheritedEnv: withoutInheritedClaudeConfigDir(process.env),
            scrubConfiguredChildSessionStamps: true
          }),
          launch.envToDelete ?? []
        ),
      pathToClaudeCodeExecutable: launch.pathToClaudeCodeExecutable,
      spawnClaudeCodeProcess: launch.evidence
        ? (options) => {
            assertEvidence()
            return spawner.spawn(options)
          }
        : spawner.spawn,
      ...(handlers.canUseTool ? { canUseTool: handlers.canUseTool } : {}),
      ...(handlers.onUserDialog ? { onUserDialog: handlers.onUserDialog } : {})
    }
  })
  return { session, spawner, inbox, evidenceServer }
}
