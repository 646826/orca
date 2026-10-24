import { conversationEvidencePreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-evidence-launch-error'
import { resolveProviderChildEnv } from '../provider-process/provider-process-launch'
import { z } from 'zod'
import { conversationContextDigest } from '../native-chat/conversations/conversation-context-consent'
import { ConversationRpcRefusal } from '../../shared/conversation-rpc-refusal'
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ConversationEvidenceLaunchPermit } from '../native-chat/conversations/conversation-evidence-registration'
import type { CodexStructuredLaunch, CodexSession } from './codex-structured-session-state'
import type { CodexAppServerServerRequest } from './codex-app-server-connection-types'

export type CodexConversationEvidence = {
  permit: ConversationEvidenceLaunchPermit
  launchFingerprint: string
  controller: AbortController
  cleanup?: Promise<void>
}
/** Only this acquisition's opaque ownership token is excluded; effective launch facts remain bound. */
export function codexEvidenceLaunchFingerprint(launch: CodexStructuredLaunch): string {
  const environment = (env: Record<string, string> | undefined) =>
    Object.fromEntries(
      Object.entries(env ?? {}).filter(([key]) => key !== 'ORCA_AGENT_SESSION_SPAWN_TOKEN')
    )
  return conversationContextDigest({
    ...launch,
    env: environment(
      Object.fromEntries(
        Object.entries(resolveProviderChildEnv(launch, process.env)).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      )
    ),
    commandEnv: environment(launch.commandEnv)
  })
}
export function prepareCodexConversationEvidence(
  input: StructuredAgentSessionAcquireInput,
  launch: CodexStructuredLaunch
): CodexConversationEvidence | undefined {
  if (!input.evidenceLaunch) {
    return undefined
  }
  let evidence: CodexConversationEvidence | undefined
  try {
    input.signal?.throwIfAborted()
    // This protocol version only registers dynamic tools at thread/start, not thread/resume.
    if (launch.resumeThreadId || input.identity.providerHandle) {
      throw new ConversationRpcRefusal('native-rebuild-required')
    }
    const launchFingerprint = codexEvidenceLaunchFingerprint(launch)
    const permit = input.evidenceLaunch.observe({
      launchFingerprint,
      transport: 'codex-dynamic-tool',
      resuming: false
    })
    evidence = { permit, launchFingerprint, controller: new AbortController() }
    permit.assertBeforeSpawn()
    return evidence
  } catch (error) {
    closeCodexConversationEvidence(evidence)
    throw conversationEvidencePreSpawnError(error)
  }
}
export function assertCodexEvidenceBeforeSpawn(
  input: StructuredAgentSessionAcquireInput,
  launch: CodexStructuredLaunch,
  evidence: CodexConversationEvidence
): void {
  try {
    input.signal?.throwIfAborted()
    if (codexEvidenceLaunchFingerprint(launch) !== evidence.launchFingerprint) {
      throw new Error('Codex resolved launch changed before spawn')
    }
    evidence.permit.assertBeforeSpawn()
  } catch (error) {
    throw conversationEvidencePreSpawnError(error)
  }
}
export function closeCodexConversationEvidence(
  evidence: CodexConversationEvidence | undefined
): void {
  if (!evidence) {
    return
  }
  evidence.controller.abort()
  evidence.cleanup ??= evidence.permit.registration.close()
  void evidence.cleanup.catch(() => {
    console.warn('[codex] conversation evidence cleanup failed')
  })
}
export function codexEvidenceToolSpec(evidence: CodexConversationEvidence) {
  const { name, description, inputSchema } = evidence.permit.registration.definition
  return { type: 'function' as const, name, description, inputSchema }
}
const callSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  callId: z.string().min(1),
  tool: z.string(),
  namespace: z.null().optional(),
  arguments: z.unknown()
})
/** This route cannot supply paths or alter scope; the host registry validates every page request. */
export function handleCodexEvidenceRequest(
  session: CodexSession,
  request: CodexAppServerServerRequest
): boolean {
  if (request.method !== 'item/tool/call' || !session.conversationEvidence) {
    return false
  }
  const evidence = session.conversationEvidence
  const parsed = callSchema.safeParse(request.params)
  const reply = (success: boolean, text: string) => {
    if (!session.connection.closed) {
      session.connection.respond(request.id, {
        success,
        contentItems: [{ type: 'inputText', text }]
      })
    }
  }
  if (
    !parsed.success ||
    parsed.data.threadId !== session.threadId ||
    parsed.data.tool !== evidence.permit.registration.definition.name ||
    session.ended ||
    session.orcaClose
  ) {
    reply(false, 'Conversation evidence request is unavailable.')
    return true
  }
  void (async () => {
    try {
      const value = await evidence.permit.registration.invoke(
        parsed.data.arguments,
        evidence.controller.signal
      )
      if (evidence.controller.signal.aborted || session.ended || session.orcaClose) {
        throw new Error('Evidence owner closed')
      }
      reply(true, JSON.stringify(value))
    } catch {
      reply(false, 'Conversation evidence request is unavailable.')
    }
  })()
  return true
}
