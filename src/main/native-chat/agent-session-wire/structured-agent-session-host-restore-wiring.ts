import { createRestartReconciler } from './structured-agent-session-restart-reconcile'
import { createStructuredAgentSessionHostRestore } from './structured-agent-session-reveal'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

type RestoreCallbacks = Pick<
  Parameters<typeof createStructuredAgentSessionHostRestore>[1],
  'serialize' | 'hasSession' | 'onReadable' | 'onUnopened'
>

export function createStructuredAgentSessionHostRestoreWiring(
  deps: StructuredAgentSessionHostDeps,
  runtimeState: StructuredAgentSessionHostRuntimeState,
  now: () => number,
  callbacks: RestoreCallbacks
) {
  const reconcileLeases = createRestartReconciler({
    store: deps.store,
    probe: (record) => runtimeState.probeRecord(record),
    ...(deps.probeOwners ? { probeMany: deps.probeOwners } : {}),
    now
  })
  return {
    reconcileLeases,
    restore: createStructuredAgentSessionHostRestore(deps, {
      ...callbacks,
      reconcileLeases,
      reconcileRestartLeases: () => reconcileLeases(),
      resolveRecovery: (sessionId) => runtimeState.resolveRecovery(sessionId)
    })
  }
}
