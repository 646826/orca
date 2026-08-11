import type { LificHealthState } from '../../../../shared/lific/lific-types'
import { lificCopy } from './lific-integration-copy'

export function lificStatusText(state: LificHealthState | null): string {
  if (!state) {
    return lificCopy.statusNotChecked()
  }
  switch (state.kind) {
    case 'ready':
      return lificCopy.statusReady(new Date(state.checkedAt).toLocaleTimeString())
    case 'not-installed':
      return lificCopy.statusNotInstalled()
    case 'not-initialized':
      return lificCopy.statusNotInitialized()
    case 'not-configured':
      return lificCopy.statusNotConfigured()
    case 'unsupported-agent':
      return lificCopy.statusUnsupportedAgent(state.agent)
    case 'authentication-failed':
    case 'unreachable':
    case 'unsupported-version':
      return state.message
  }
}
