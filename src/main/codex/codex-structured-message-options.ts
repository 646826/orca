import type { AgentSessionExecutionOptions } from '../../shared/agent-session-execution-options'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { readCodexConfiguredLaunchDefaults } from './codex-configured-launch-defaults'
import {
  codexAcquireCatalogListing,
  codexSessionCapabilities
} from './codex-structured-catalog-entry'
import { CODEX_DEFAULT_SERVICE_TIER, codexRanOptions } from './codex-structured-service-tier'
import { codexConversationCapabilities } from './codex-conversation-capabilities'
import type { CodexSession } from './codex-structured-session-state'
import {
  applyCodexStructuredSessionOption,
  applyCodexStructuredSessionOptionValue
} from './codex-structured-session-options'

/** Resolve per-message overrides without replacing the session's saved picks. */
export async function resolvedCodexMessageOptions(
  session: CodexSession,
  choices: AgentSessionExecutionOptions | undefined
): Promise<Readonly<Record<string, string>> | undefined> {
  if (choices === undefined) {
    return undefined
  }
  const defaults = codexMessageDefaults(session, choices)
  // Capture configuration before our first override, never from mutable turn reports.
  if (
    (choices.personality && !session.nativeDefaults?.personality) ||
    ((choices.serviceTier || choices.fastMode) && !session.nativeDefaults?.serviceTier)
  ) {
    const configured = await readCodexConfiguredLaunchDefaults(session.connection)
    session.nativeDefaults = {
      ...session.nativeDefaults,
      ...(configured?.personality && !session.nativeDefaults?.personality
        ? { personality: configured.personality }
        : {}),
      ...(configured?.serviceTier && !session.nativeDefaults?.serviceTier
        ? { serviceTier: configured.serviceTier }
        : {})
    }
  }
  const selected = codexMessageSelection(session, choices, defaults)
  if (choices.fastMode !== undefined) {
    await applyCodexStructuredSessionOption(selected, 'fastMode', choices.fastMode)
  }
  return codexMessageOptionsResult(selected, choices)
}

function codexMessageDefaults(session: CodexSession, choices: AgentSessionExecutionOptions) {
  const listing = codexAcquireCatalogListing(session.catalogAccess)
  const priorModel = session.options.get('model')
  const priorEffort = session.options.get('effort')
  // Keep the thread's effort unless switching models.
  const thread = session.reportedOptions
  const model =
    choices.model ?? thread.model ?? listing?.models.find((entry) => entry.isDefault)?.id
  if (!model && (choices.effort || priorModel || priorEffort)) {
    throw new AgentSessionOptionRejectedError(new Error('codex default model is unavailable'))
  }
  const listedModel = listing?.models.find((entry) => entry.id === model)
  const threadEffort = model === thread.model ? thread.effort : undefined
  const defaultEffort = threadEffort ?? listedModel?.defaultEffort
  if (choices.effort === undefined && priorEffort && !defaultEffort) {
    throw new AgentSessionOptionRejectedError(new Error('codex default effort is unavailable'))
  }
  return { model, priorModel, priorEffort, defaultEffort }
}

function codexMessageSelection(
  session: CodexSession,
  choices: AgentSessionExecutionOptions,
  { model, priorModel, priorEffort, defaultEffort }: ReturnType<typeof codexMessageDefaults>
): CodexSession {
  const restored: Record<string, string> = {}
  for (const key of ['personality', 'serviceTier'] as const) {
    const applied = session.appliedTurnOptions?.[key]
    if (
      choices[key] !== undefined ||
      (key === 'serviceTier' && choices.fastMode !== undefined) ||
      !applied
    ) {
      continue
    }
    const baseline = session.nativeDefaults?.[key]
    if (!baseline) {
      throw new AgentSessionOptionRejectedError(new Error(`codex default ${key} is unavailable`))
    }
    if (applied !== baseline) {
      restored[key] = baseline
    }
  }
  const selected = {
    ...session,
    options: new Map<string, string>(Object.entries(restored)),
    reportedOptions: { ...session.reportedOptions, effort: undefined }
  }
  if (
    model &&
    (choices.model ||
      priorModel ||
      priorEffort ||
      choices.effort ||
      choices.fastMode === 'true' ||
      (choices.serviceTier && choices.serviceTier !== CODEX_DEFAULT_SERVICE_TIER))
  ) {
    // Preserve previously admitted choices across installation changes.
    selected.options.set('model', model)
    if (!defaultEffort && choices.effort === undefined) {
      selected.options.delete('effort')
    }
    if (
      choices.effort === undefined &&
      defaultEffort &&
      (priorEffort || choices.model || selected.options.has('effort'))
    ) {
      selected.options.set('effort', defaultEffort)
    }
  }
  for (const key of ['effort', 'personality'] as const) {
    const value = choices[key]
    if (value !== undefined) {
      selected.options.set(key, value)
    }
  }
  return selected
}

function codexMessageOptionsResult(session: CodexSession, choices: AgentSessionExecutionOptions) {
  if (choices.serviceTier !== undefined) {
    session.options.set('serviceTier', choices.serviceTier)
  }
  return Object.fromEntries(session.options)
}

export function projectCodexSessionOptions(
  session: CodexSession | undefined,
  options: Readonly<Record<string, string>>
) {
  if (!session || session.ended || session.connection.closed) {
    return undefined
  }
  try {
    const selected = codexMessageSelection(session, options, codexMessageDefaults(session, options))
    if (selected.contextDeliveryObservation) {
      selected.contextDeliveryObservation = { ...selected.contextDeliveryObservation }
    }
    if (options.fastMode !== undefined) {
      applyCodexStructuredSessionOptionValue(selected, 'fastMode', options.fastMode)
    }
    if (
      selected.contextDeliveryObservation?.selectionRevision !==
      session.contextDeliveryObservation?.selectionRevision
    ) {
      return undefined
    }
    codexMessageOptionsResult(selected, options)
    const current = codexConversationCapabilities(session)
    const next = codexConversationCapabilities({
      ...session,
      options: selected.options,
      contextDeliveryObservation: selected.contextDeliveryObservation
    })
    if (
      current.state === 'verified' &&
      (next.state !== 'verified' || next.runtimeFingerprint !== current.runtimeFingerprint)
    ) {
      return undefined
    }
    return {
      models: codexSessionCapabilities(selected).models,
      options: { ...options, ...codexRanOptions(selected) }
    }
  } catch (error) {
    if (error instanceof AgentSessionOptionRejectedError) {
      return undefined
    }
    throw error
  }
}
