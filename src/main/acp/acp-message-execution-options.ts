import { providerDiagnostic, withProviderDiagnostic } from '../../shared/agent-session-failure'
import type { AgentSessionExecutionOptions } from '../../shared/agent-session-execution-options'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { AcpAgentError } from './acp-errors'
import type { AcpStructuredOptions } from './acp-structured-options'
import type { AcpStructuredSession } from './acp-structured-session'
import { acpPromptErrorDetail } from './acp-turn-failures'

export function* acpMessageOptionWrites(
  state: AcpStructuredOptions,
  requested: AgentSessionExecutionOptions | undefined
) {
  if (!requested) {
    return
  }
  const initial = state.messageDefault()
  const model = requested?.model ?? initial.model
  const defaultEffort =
    model === initial.model
      ? initial.effort
      : state.read().models.find((entry) => entry.id === model)?.defaultEffort
  for (const key of ['model', 'effort'] as const) {
    const value = requested?.[key] ?? (key === 'model' ? initial.model : defaultEffort)
    if (value === undefined) {
      const applied = state.applied.get(key)
      if (applied !== undefined && applied !== initial[key]) {
        throw new AgentSessionOptionRejectedError(
          new Error(`The default ${key} for this model is unknown`)
        )
      }
      continue
    }
    if (state.currentProof.has(key) && state.reported()[key] === value) {
      continue
    }
    yield { key, value }
  }
}

export async function applyAcpMessageOptions(
  session: AcpStructuredSession,
  options: AgentSessionExecutionOptions | undefined,
  setOption: (key: 'model' | 'effort', value: string) => Promise<unknown>,
  isCurrent: () => boolean,
  signal?: AbortSignal
): Promise<boolean> {
  for (const { key, value } of acpMessageOptionWrites(session.options, options)) {
    try {
      await setOption(key, value)
    } catch (error) {
      signal?.throwIfAborted()
      if (!isCurrent()) {
        return false
      }
      if (error instanceof AcpAgentError) {
        throw withProviderDiagnostic(
          new AgentSessionOptionRejectedError(error),
          providerDiagnostic(acpPromptErrorDetail(session.spec.dialect, error), 'person')
        )
      }
      throw new AgentSessionOptionRejectedError(error)
    }
    if (!isCurrent()) {
      return false
    }
  }
  return true
}
