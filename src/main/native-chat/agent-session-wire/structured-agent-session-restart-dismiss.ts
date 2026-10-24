import type { StructuredAgentSessionRestartFailureLedger } from './structured-agent-session-restart-failure-ledger'
import type { StructuredAgentSessionRestartResume } from './structured-agent-session-restart-resume-contract'
import type { StructuredAgentSessionRestartAudience } from './structured-agent-session-restart-resume-set'

/** Explicit dismissal fences captured witnesses; later captures remain independent offers. */
export function createRestartResumeDismiss(
  failures: Pick<StructuredAgentSessionRestartFailureLedger, 'dismiss'>,
  witnesses: { clear: (audience?: StructuredAgentSessionRestartAudience) => void },
  revealEvery: () => Promise<void>
): StructuredAgentSessionRestartResume['dismiss'] {
  return (sessionIds, audience, assertMutationSupported) =>
    failures.dismiss(
      sessionIds,
      async (clearAudience) => {
        witnesses.clear(clearAudience)
        await revealEvery()
      },
      audience,
      assertMutationSupported
    )
}
