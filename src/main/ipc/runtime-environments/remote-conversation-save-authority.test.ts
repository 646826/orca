import { beforeEach, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { NATIVE_CONVERSATION_RUNTIME_CAPABILITY } from '../../../shared/conversation-runtime-capabilities'
import { remoteConversationSaveAuthority } from './remote-conversation-save-authority'
const state = vi.hoisted((): { verified: boolean; capabilities: string[] } => ({
  verified: true,
  capabilities: []
}))
vi.mock('../../../shared/runtime-environment-store', () => ({
  resolveEnvironment: () => ({ id: 'remote-save', pairingRevision: 1, runtimeId: 'server' })
}))
vi.mock('./runtime-environment-request-connections', () => ({
  getRuntimeEnvironmentStatusOwner: () => ({
    read: () => ({
      verification: state.verified ? 'verified' : 'unverified',
      retired: false,
      pairingRevision: 1,
      status: { runtimeId: 'server', capabilities: state.capabilities }
    })
  })
}))
const save = () =>
  remoteConversationSaveAuthority({
    userDataPath: '/synthetic-profile',
    hostId: 'runtime:remote-save',
    current: getDefaultWorkspaceSession(),
    incoming: getDefaultWorkspaceSession()
  })
beforeEach(() => {
  state.verified = true
  state.capabilities = []
})
it('preserves ordinary verified old-host saves without inventing a conversation census', () => {
  expect(save()).toEqual([])
})
it('blocks a capable host save without its live census even if the mirror has never seen hidden tabs', () => {
  state.capabilities = [NATIVE_CONVERSATION_RUNTIME_CAPABILITY]
  expect(save).toThrow()
})
it('does not authorize an empty mirror from an unverified or disconnected host', () => {
  state.verified = false
  expect(save).toThrow()
})
