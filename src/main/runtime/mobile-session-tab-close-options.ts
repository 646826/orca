import type { RuntimeSessionTabCloseReason } from '../../shared/runtime-types'
import type { RuntimePtyTabCloseAuthority } from './runtime-terminal-state-records'

export type MobileSessionTabCloseOptions = {
  assertAgentSessionMutation?: (sessionId: string) => void
  reason?: RuntimeSessionTabCloseReason
  expectedPublicationEpoch?: string
  expectedTerminalHandle?: string
  clientNavigationId?: string
  localPtyTeardownOwnedExternally?: boolean
  expectedPtyCloseAuthority?: RuntimePtyTabCloseAuthority
  force?: boolean
}
