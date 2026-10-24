import {
  codexEvidenceToolSpec,
  type CodexConversationEvidence
} from './codex-conversation-evidence'
import { codexConversationCapabilities } from './codex-conversation-capabilities'
import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type {
  StructuredAgentSessionProviderOpenInput,
  StructuredAgentSessionProviderOpenResult
} from '../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
import { initializeCodexAppServerConnection } from './codex-app-server-handshake'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { CodexBackgroundTaskTracker, codexChildWorkSink } from './codex-background-task-tracker'
import type { CodexSubagentExecutions } from './codex-subagent-executions'
import type { CodexDispatchEchoes } from './codex-structured-dispatch-echo'
import type { CodexJournalTranslator } from './codex-structured-journal-translation'
import { codexProviderHandleLink } from './codex-structured-owner-identity'
import { openCodexThread } from './codex-structured-thread-open'
import { catchUpCodexThread } from './codex-structured-thread-catch-up'
import { withCodexVisualsThreadConfig } from './codex-structured-visuals'
import { NATIVE_CHAT_SCRATCH_DIR_ENV } from '../native-chat/native-chat-visuals-delivery'
import {
  restoredCodexSessionOptions,
  reportedCodexSessionOptions
} from './codex-structured-session-options'
import { CodexSkillReport } from './codex-structured-skill-report'
import { codexAcquireCatalogAccess } from './codex-structured-acquire-catalog'
import { reportedCodexThreadOptions } from './codex-structured-service-tier'
import {
  assertCodexConnectionOpen,
  codexSessionLifecycle,
  type CodexAcquisitionRegistry,
  type CodexAcquisitionAttempt,
  type CodexSession,
  type CodexStructuredLaunch,
  type CodexStructuredSessionAdapterDeps
} from './codex-structured-session-state'
import type { CodexStructuredSessionTeardown } from './codex-structured-session-teardown'

type CodexOpenContext = {
  input: StructuredAgentSessionAcquireInput
  deps: CodexStructuredSessionAdapterDeps
  conversationEvidence?: CodexConversationEvidence
  launch: CodexStructuredLaunch
  account: AgentSessionAccountKind | undefined
  sessions: Map<string, CodexSession>
  acquisitions: CodexAcquisitionRegistry
  attempt: CodexAcquisitionAttempt
  connection: CodexAppServerConnection
  translator: CodexJournalTranslator | null
  dispatchEchoes: CodexDispatchEchoes
  subagentExecutions: CodexSubagentExecutions
  setPrimaryThreadId: (threadId: string) => void
  forceCloseUnexpected: CodexStructuredSessionTeardown['forceCloseUnexpected']
  unbindReadingControl?: () => void
}

/** The host owns the open promise and closes the spawned child if this rejects. */
export async function openCodexStructuredSession(
  start: CodexOpenContext,
  openInput: StructuredAgentSessionProviderOpenInput
): Promise<StructuredAgentSessionProviderOpenResult> {
  const { input, deps, launch, sessions, acquisitions, attempt, connection, translator } = start
  const sessionId = input.identity.sessionId
  const generation = attempt.acquisitionGeneration
  if (
    generation === undefined ||
    openInput.sessionId !== sessionId ||
    openInput.fence !== input.fence ||
    openInput.acquisitionGeneration !== generation
  ) {
    throw new Error('codex open does not match the spawned child')
  }
  const current = (): void => {
    throwIfSignalAborted(openInput.signal)
    if (attempt.exitError) {
      throw attempt.exitError
    }
    acquisitions.assertCurrent(sessionId, attempt)
    assertCodexConnectionOpen(connection, sessionId)
  }
  current()
  const contextDeliveryVersion = await waitForPromiseWithSignal(
    initializeCodexAppServerConnection(connection, null),
    openInput.signal
  )
  current()
  if (start.conversationEvidence && contextDeliveryVersion !== '0.159.0-alpha.3') {
    throw new Error('Codex dynamic tool protocol version is unverified')
  }
  const threadLaunch = await waitForPromiseWithSignal(
    withCodexVisualsThreadConfig(connection, launch, {
      sessionId,
      ...(deps.logger ? { logger: deps.logger } : {})
    }),
    openInput.signal
  )
  current()
  const commandEnv = {
    ...launch.commandEnv,
    ...(launch.visuals ? { [NATIVE_CHAT_SCRATCH_DIR_ENV]: launch.visuals.folder } : {})
  }
  const opened = await waitForPromiseWithSignal(
    openCodexThread(
      connection,
      {
        ...threadLaunch,
        commandEnv,
        ...(start.conversationEvidence
          ? { dynamicTools: [codexEvidenceToolSpec(start.conversationEvidence)] }
          : {})
      },
      // Long rollout/MCP setup relies on the host ceiling and cancellation unless a timeout is supplied.
      deps.requestTimeoutMs ?? null,
      openInput.signal
    ),
    openInput.signal
  )
  current()
  start.setPrimaryThreadId(opened.threadId)
  const restored = translator?.restoreThread(opened.threadId, opened.thread ?? {})
  if (restored && !restored.accepted) {
    throw AgentSessionAcquisitionRefusal.historyTooLarge(
      'Codex thread history exceeds the bounded restore queue; history was not partially imported.'
    )
  }
  if (
    translator &&
    input.events &&
    launch.resumeThreadId !== null &&
    !opened.supersededThreadId &&
    !threadReturnedTurns(opened.thread)
  ) {
    await waitForPromiseWithSignal(
      catchUpCodexThread({
        connection,
        threadId: opened.threadId,
        sessionId,
        sink: input.events,
        signal: openInput.signal,
        assertCurrent: current,
        ...(deps.requestTimeoutMs !== undefined ? { timeoutMs: deps.requestTimeoutMs } : {}),
        ...(deps.logger ? { logger: deps.logger } : {})
      }),
      openInput.signal
    )
    current()
  }
  const catalogAccess = codexAcquireCatalogAccess(deps, launch, sessionId)
  const session: CodexSession = {
    ...(start.conversationEvidence ? { conversationEvidence: start.conversationEvidence } : {}),
    contextDeliveryObservation: {
      agent: 'codex',
      protocol: 'codex-app-server-v2',
      version: contextDeliveryVersion,
      nativeSessionId: opened.threadId,
      acquisitionGeneration: generation,
      fence: input.fence,
      launch: {
        command: launch.command,
        cwd: launch.cwd,
        permission: JSON.stringify(launch.permissionPolicy ?? null)
      },
      options: {},
      initialized: true,
      closed: false,
      resume: true
    },
    events: input.events,
    account: start.account,
    connection,
    ...codexSessionLifecycle(input.fence, generation),
    threadId: opened.threadId,
    historyMode: opened.historyMode,
    activeTurnIds: new Set(),
    abortedTurnIds: new Set(),
    prompts: attempt.window.prompts,
    options: restoredCodexSessionOptions(input.options),
    reportedOptions: reportedCodexThreadOptions(opened),
    ...(catalogAccess ? { catalogAccess } : {}),
    dispatchEchoes: start.dispatchEchoes,
    translator,
    backgroundTasks: new CodexBackgroundTaskTracker(
      opened.threadId,
      start.subagentExecutions,
      codexChildWorkSink(sessionId, deps, input.events)
    ),
    forceCloseUnexpected: (reason) =>
      start.forceCloseUnexpected(sessionId, input.fence, generation, reason),
    ...(start.unbindReadingControl ? { unbindReadingControl: start.unbindReadingControl } : {})
  }
  if (opened.serviceTier) {
    session.nativeDefaults = { ...session.nativeDefaults, serviceTier: opened.serviceTier }
  }
  current()
  sessions.set(sessionId, session)
  if (start.conversationEvidence) {
    const capabilities = codexConversationCapabilities(session)
    if (capabilities.state !== 'verified') {
      throw new Error('Codex tool ownership is unverified')
    }
    start.conversationEvidence.permit.registration.confirm({
      nativeSessionId: opened.threadId,
      acquisitionGeneration: generation,
      runtimeFence: input.fence,
      baseCapabilityFingerprint: capabilities.runtimeFingerprint,
      launchFingerprint: start.conversationEvidence.launchFingerprint,
      transport: 'codex-dynamic-tool'
    })
  }
  for (const event of attempt.window.drain()) {
    event()
  }
  current()
  acquisitions.deleteIfCurrent(sessionId, attempt)
  session.skillReport = new CodexSkillReport({
    connection,
    cwd: launch.cwd,
    sessionId,
    isCurrent: () => sessions.get(sessionId) === session && !session.ended,
    publish: () => input.events?.publish(),
    ...(deps.requestTimeoutMs !== undefined ? { timeoutMs: deps.requestTimeoutMs } : {}),
    ...(deps.logger ? { logger: deps.logger } : {})
  })
  session.skillReport.refresh()
  return {
    link: codexProviderHandleLink({
      threadId: opened.threadId,
      ...(opened.supersededThreadId
        ? { resumed: false, supersedesThreadId: opened.supersededThreadId }
        : { resumed: launch.resumeThreadId !== null }),
      fence: input.fence,
      linkId: deps.mintLinkId?.(),
      observedAt: deps.now?.() ?? Date.now()
    }),
    reportedOptions: reportedCodexSessionOptions(session)
  }
}

/** Older Codex versions return history inline, already handled by restoreThread. */
function threadReturnedTurns(thread: Record<string, unknown> | undefined): boolean {
  return Array.isArray(thread?.turns) && thread.turns.length > 0
}
