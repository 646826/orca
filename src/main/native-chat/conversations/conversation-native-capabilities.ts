import { createHash } from 'node:crypto'
import type { ConversationContextCapabilities } from '../../../shared/conversation-context-capabilities'

/** Reviewed protocol contracts, not successful authenticated prompt evaluations or version floors. */
const CONTRACTS = new Set([
  'codex:codex-app-server-v2:0.159.0-alpha.3',
  'claude:claude-sdk-stream:2.1.309',
  'opencode:acp-1:1.19.4'
])
export type NativeConversationCapabilityObservation = {
  agent: string
  protocol: string
  version: string | null
  nativeSessionId: string
  acquisitionGeneration: string
  fence: number
  /** Only nonsecret resolved executable/workspace/permission facts, never child environment. */
  launch: Readonly<Record<string, string>>
  options: Readonly<Record<string, string>>
  reportedBaseline?: Readonly<Record<string, string>>
  reportRevision?: number
  selectionRevision?: number
  initialized: boolean
  closed: boolean
  resume: boolean
}
const sorted = (value: Readonly<Record<string, string>>) =>
  Object.entries(value).sort(([a], [b]) => a.localeCompare(b))

export function nativeConversationCapabilities(
  value: NativeConversationCapabilityObservation | null | undefined
): ConversationContextCapabilities {
  if (
    !value ||
    !value.initialized ||
    value.closed ||
    !value.nativeSessionId ||
    !value.acquisitionGeneration ||
    !Number.isSafeInteger(value.fence) ||
    value.fence < 1 ||
    !CONTRACTS.has(`${value.agent}:${value.protocol}:${value.version}`)
  ) {
    return { state: 'unverified' }
  }
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        evidence: 'protocol-contract',
        agent: value.agent,
        protocol: value.protocol,
        version: value.version,
        nativeSessionId: value.nativeSessionId,
        acquisitionGeneration: value.acquisitionGeneration,
        fence: value.fence,
        selectionRevision: value.selectionRevision ?? 0,
        launch: sorted(value.launch),
        options: sorted(value.options),
        resume: value.resume
      })
    )
    .digest('hex')
  return {
    state: 'verified',
    runtimeFingerprint: fingerprint,
    acquisitionGeneration: value.acquisitionGeneration,
    passiveImport: 'unsupported',
    firstTurnReceipt: 'live-acceptance',
    nonMutatingHydration: 'unsupported',
    startupTrust: 'unverified',
    resume: value.resume ? 'native' : 'unsupported',
    artifactAccess: ['text'],
    budget: 'unknown'
  }
}

/** First discovery of a provider default is telemetry, not a selection change. Once a value is
 * known, changing it invalidates prepared delivery even if it later changes back. */
export function nativeConversationReportedOptions(
  observation: NativeConversationCapabilityObservation,
  current: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  if (!observation.reportedBaseline) {
    observation.reportedBaseline = { ...current }
    observation.options = { ...current }
  } else {
    for (const [key, value] of Object.entries(current)) {
      const previous = observation.reportedBaseline[key]
      if (previous !== undefined && previous !== value) {
        observation.reportRevision = (observation.reportRevision ?? 0) + 1
      }
    }
    observation.reportedBaseline = { ...observation.reportedBaseline, ...current }
  }
  return { ...observation.options, reportRevision: String(observation.reportRevision ?? 0) }
}
