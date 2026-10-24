import type * as ClaudeAgentSdk from '@anthropic-ai/claude-agent-sdk'
import type { ConversationEvidencePendingRegistration } from '../native-chat/conversations/conversation-evidence-registration'
import {
  conversationEvidenceToolInput,
  CONVERSATION_EVIDENCE_TOOL_NAME
} from '../native-chat/conversations/conversation-evidence-tool-contract'
export const CLAUDE_CONVERSATION_EVIDENCE_SERVER = 'orca-conversation-evidence'
export async function invokeClaudeConversationEvidence(
  registration: ConversationEvidencePendingRegistration,
  raw: unknown,
  extra: unknown
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    if (
      typeof extra !== 'object' ||
      extra === null ||
      !('signal' in extra) ||
      !(extra.signal instanceof AbortSignal)
    ) {
      throw new Error('Missing tool request cancellation')
    }
    extra.signal.throwIfAborted()
    const result = await registration.invoke(raw, extra.signal)
    extra.signal.throwIfAborted()
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  } catch {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Conversation evidence is unavailable for this request.' }]
    }
  }
}
export function createClaudeConversationEvidenceServer(
  sdk: Pick<typeof ClaudeAgentSdk, 'createSdkMcpServer' | 'tool'>,
  registration: ConversationEvidencePendingRegistration
) {
  const definition = registration.definition
  return sdk.createSdkMcpServer({
    name: CLAUDE_CONVERSATION_EVIDENCE_SERVER,
    version: '1.0.0',
    tools: [
      sdk.tool(
        definition.name,
        definition.description,
        conversationEvidenceToolInput.shape,
        (args, extra) => invokeClaudeConversationEvidence(registration, args, extra),
        { annotations: definition.annotations }
      )
    ]
  })
}
export function hasClaudeConversationEvidenceRegistration(
  servers: readonly ClaudeAgentSdk.McpServerStatus[]
): boolean {
  return servers.some(
    (server) =>
      server.name === CLAUDE_CONVERSATION_EVIDENCE_SERVER &&
      server.source === 'sdk' &&
      server.status === 'connected' &&
      server.tools?.some((tool) => tool.name === CONVERSATION_EVIDENCE_TOOL_NAME)
  )
}
