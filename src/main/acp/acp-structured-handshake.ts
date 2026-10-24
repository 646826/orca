import { acpConversationCapabilities } from './acp-conversation-capabilities'
import { startAcpEvidenceServer, type AcpConversationEvidence } from './acp-conversation-evidence'
import { createLegacyProviderTimelineIdentityScheme } from '../native-chat/agent-session-timeline/provider-timeline-identity'
// Suppress replayed history during reattach; preserve context usage.

import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionProviderOpenResult } from '../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
import {
  ACP_REOPEN_FAILED,
  acpReopenTakeover,
  acpSessionNotRestoredRow
} from './acp-session-reopen-failure'
import { ACP_HANDLE_TRANSPORT, acpAgentName } from './acp-structured-agent-definitions'
import { probeAcpChildStops } from './acp-structured-child-stop'
import type { AcpStructuredConnection } from './acp-structured-connection'
import type { AcpStructuredLane } from './acp-structured-lane'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'
import type { AcpStructuredOptions } from './acp-structured-options'
import type { AcpStructuredPrompts } from './acp-structured-prompts'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'
import { AcpStructuredTurns, type AcpStructuredTurnsDeps } from './acp-structured-turns'
import {
  assertAcpStartingSession,
  isAcpReadySession,
  type AcpStructuredChild
} from './acp-structured-child'

type AcpHandshakeInput = {
  evidence?: AcpConversationEvidence
  acquire: StructuredAgentSessionAcquireInput
  deps: AcpStructuredSessionAdapterDeps
  generation: string
  launch: AcpStructuredLaunch
  connection: AcpStructuredConnection
  options: AcpStructuredOptions
  prompts: AcpStructuredPrompts
  child: AcpStructuredChild
  abandoned: () => boolean
  lanes: {
    create: (providerSessionId: string, attaching?: boolean) => AcpStructuredLane
    clear: () => void
    finishLoad: () => void
  }
  onSettled: AcpStructuredTurnsDeps['settle']
}

export async function initializeAcpStructuredSession(
  input: AcpHandshakeInput
): Promise<StructuredAgentSessionProviderOpenResult> {
  const { acquire, deps, launch, connection, options, prompts, child, onSettled } = input
  const { spec } = deps
  const sessionId = acquire.identity.sessionId
  const now = deps.now ?? Date.now
  const assertStarting = () => assertAcpStartingSession(child, input.abandoned)
  const agentName = acpAgentName(spec.agent)
  assertStarting()
  const initialized = await connection.initialize()
  assertStarting()
  // Choose authentication using the execution host's launch environment.
  const authMethodId = spec.authMethod?.({
    advertised: (initialized.authMethods ?? []).map((method) => method.id),
    env: launch.env
  })
  const mcpServers = input.evidence
    ? [await startAcpEvidenceServer(input.evidence, initialized, spec.agent)]
    : []
  assertStarting()
  const setup = { authMethodId, resumePreference: spec.resumePreference }
  const resume = launch.resume
  let started: Awaited<ReturnType<AcpStructuredConnection['start']>> | null = null
  let liveLane: AcpStructuredLane | null = null
  let takeover: ReturnType<typeof acpReopenTakeover> | null = null
  if (resume) {
    const attaching = input.lanes.create(resume.sessionId, true)
    liveLane = attaching
    try {
      started = await connection.start({
        cwd: launch.cwd,
        mcpServers,
        sessionId: resume.sessionId,
        ...setup
      })
      assertStarting()
      input.lanes.finishLoad()
      attaching.translator.finishLoad()
    } catch (error) {
      assertStarting()
      takeover = acpReopenTakeover(error, resume, {
        over: connection.closed || input.abandoned(),
        now: now(),
        warn: (fields) => deps.logger?.warn(ACP_REOPEN_FAILED, { ...fields, sessionId })
      })
    }
  }
  if (!started || !liveLane) {
    liveLane?.dispose()
    input.lanes.clear()
    started = await connection.start({ cwd: launch.cwd, mcpServers, ...setup })
    assertStarting()
    liveLane = input.lanes.create(started.sessionId)
  }
  const childStops = await probeAcpChildStops(connection, spec.dialect)
  assertStarting()
  options.adoptSession(started.response, started.kind === 'new' ? 'new' : 'loaded')
  liveLane.apply(liveLane.translator.contextModels(started.response.models, now()))
  const mode = spec.permissionModeConfig
  if (mode) {
    // Fail startup rather than silently use a different permission mode.
    const requested = mode.values[acquire.permissionMode ?? 'ask'] ?? mode.values.ask
    const configId = options.modeConfigId()
    const { configOptions } = await connection.setConfigOption(configId, requested)
    assertStarting()
    if (configOptions.find((option) => option.id === configId)?.currentValue !== requested) {
      throw new Error('Permission mode could not be confirmed')
    }
    options.adoptSession(
      { ...started.response, configOptions },
      started.kind === 'new' ? 'new' : 'loaded'
    )
  }
  const link: AgentSessionProviderHandleLink = {
    linkId:
      deps.mintLinkId?.() ?? `${spec.agent}-${acquire.fence}-${started.sessionId}`.slice(0, 128),
    handle: { transport: ACP_HANDLE_TRANSPORT, agent: spec.agent, nativeId: started.sessionId },
    origin: started.kind === 'new' ? 'created' : 'resumed',
    mintedAtFence: acquire.fence,
    observedAt: now(),
    ...takeover
  }
  const reading = liveLane
  const unbind = acquire.events?.bindReadingControl?.({
    pauseReading: () => connection.pauseReading(),
    resumeReading: () => {
      connection.resumeReading()
      reading.retry()
    }
  })
  if (unbind) {
    child.unbindReadingControl = unbind
  }
  if (connection.exited || connection.closed) {
    throw new Error(connection.stderrTail() || `${spec.command} exited while starting`)
  }
  // Include warning rows missed by earlier failed starts.
  const lost = [
    ...(launch.resume?.unannouncedLosses() ?? []),
    ...(takeover?.replaces ? [takeover.replaces.key] : [])
  ]
  for (const key of lost) {
    liveLane.apply(acpSessionNotRestoredRow(key, started.sessionId, agentName))
  }
  assertStarting()
  Object.assign(child, {
    contextDeliveryObservation: {
      agent: spec.agent,
      protocol: `acp-${initialized.protocolVersion}`,
      version: initialized.agentInfo?.version ?? null,
      nativeSessionId: started.sessionId,
      acquisitionGeneration: child.acquisitionGeneration,
      fence: child.fence,
      launch: {
        command: launch.command,
        cwd: launch.cwd,
        permission: launch.fullAccess ? 'full-access' : 'ask'
      },
      options: {},
      initialized: true,
      closed: false,
      resume: initialized.agentCapabilities?.loadSession === true
    },
    childStops,
    lane: liveLane,
    turns: new AcpStructuredTurns({
      connection,
      withdrawRequests: () => prompts.withdrawAll(),
      lane: liveLane,
      agentName,
      now,
      settle: (settlement) => {
        if ('originCorrelation' in settlement && settlement.originCorrelation === 'exact') {
          // A correlated prompt response establishes this local prompt's causal identity;
          // the separate settlement still supplies the acceptance evidence.
          deps.onDispatchSettledLate?.({
            state: 'origin-correlated',
            sessionId,
            clientMessageId: settlement.clientMessageId,
            fence: child.fence,
            turnIdentity: createLegacyProviderTimelineIdentityScheme({
              agent: spec.agent,
              sessionId
            }).turn({
              namespace: started.sessionId,
              key: { source: 'provider', value: `prompt:${settlement.clientMessageId}` }
            })
          })
        }
        onSettled(settlement)
      }
    })
  })
  if (!isAcpReadySession(child)) {
    throw new Error('ACP session did not open')
  }
  if (input.evidence) {
    const capabilities = acpConversationCapabilities(child)
    if (capabilities.state !== 'verified') {
      throw new Error('ACP evidence owner unverified')
    }
    input.evidence.permit.registration.confirm({
      nativeSessionId: started.sessionId,
      acquisitionGeneration: child.acquisitionGeneration,
      runtimeFence: child.fence,
      baseCapabilityFingerprint: capabilities.runtimeFingerprint,
      launchFingerprint: input.evidence.launchFingerprint,
      transport: 'acp-http-mcp'
    })
  }
  return {
    link,
    reportedOptions: options.read().current,
    catalogListing: options.startListing()
  }
}
