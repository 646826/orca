import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { claudeAndCodexRouter } from './structured-agent-session-adapter-router-test-support'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { ConversationContextCapabilities } from '../../../shared/conversation-context-capabilities'

function adapter(): StructuredAgentSessionAdapter {
  return {
    acquire: vi.fn(),
    open: vi.fn(),
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn()
  }
}

describe('native context delivery capability admission', () => {
  it.each(['claude', 'codex', 'opencode'])(
    'keeps an unverified or unregistered %s target closed',
    (agent) => {
      const claude = adapter()
      const codex = adapter()
      const router = claudeAndCodexRouter({ claude, codex }, async () => {})
      expect(router.contextDeliveryCapabilities('parked', agent)).toEqual({
        state: 'unverified'
      })
      expect(claude.acquire).not.toHaveBeenCalled()
      expect(codex.acquire).not.toHaveBeenCalled()
    }
  )

  it('queries only the live owner and refuses a conflicting provider namespace', async () => {
    const evidence: ConversationContextCapabilities = {
      state: 'verified',
      runtimeFingerprint: 'test-native-version',
      acquisitionGeneration: 'acquisition-1',
      passiveImport: 'unsupported',
      firstTurnReceipt: 'live-acceptance',
      nonMutatingHydration: 'unsupported',
      startupTrust: 'unverified',
      resume: 'native',
      artifactAccess: ['text'],
      budget: 'unknown'
    }
    const claude = adapter()
    claude.acquire = vi.fn(async () => ({
      process: { hostId: 'local', pid: 1, processStartTimeMs: 1, spawnToken: 'spawn-1' },
      acquisitionGeneration: 'acquisition-1'
    }))
    claude.contextDeliveryCapabilities = vi.fn(() => evidence)
    const codex = adapter()
    codex.contextDeliveryCapabilities = vi.fn(() => evidence)
    const router = claudeAndCodexRouter({ claude, codex }, async () => {})
    await router.acquire({
      identity: {
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'claude',
        providerHandle: claudeProviderHandle('native-1', null)
      },
      fence: 1,
      spawnToken: 'spawn-1'
    })
    expect(router.contextDeliveryCapabilities('session-1', 'claude')).toEqual(evidence)
    expect(claude.contextDeliveryCapabilities).toHaveBeenCalledExactlyOnceWith('session-1')
    expect(router.contextDeliveryCapabilities('session-1', 'codex')).toEqual({
      state: 'unverified'
    })
    expect(codex.contextDeliveryCapabilities).not.toHaveBeenCalled()
    expect(claude.contextDeliveryCapabilities).toHaveBeenCalledTimes(1)
    expect(router.contextDeliveryCapabilities('session-1')).toEqual(evidence)
    expect(claude.contextDeliveryCapabilities).toHaveBeenCalledTimes(2)
    expect(router.contextDeliveryCapabilities('missing')).toEqual({ state: 'unverified' })
  })

  it('does not substitute another provider capability for an unknown target', () => {
    const claude = adapter()
    claude.contextDeliveryCapabilities = vi.fn(() => ({ state: 'unverified' as const }))
    const router = claudeAndCodexRouter({ claude, codex: adapter() }, async () => {})
    expect(router.contextDeliveryCapabilities('parked', 'opencode')).toEqual({
      state: 'unverified'
    })
    expect(claude.contextDeliveryCapabilities).not.toHaveBeenCalled()
  })
})
