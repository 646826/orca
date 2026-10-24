import { expect, it, vi } from 'vitest'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import { ConversationEvidenceStartupTrustRequiredError } from '../native-chat/conversations/conversation-evidence-launch-gate'
it('observes actual resolved launch and refuses unapproved MCP before any native spawn', async () => {
  const openConnection = vi.fn(async () => {
    throw new Error('native spawn must not run')
  })
  const observe = vi.fn(() => {
    throw new ConversationEvidenceStartupTrustRequiredError()
  })
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: { permissionMode: 'default' },
      cwd: '/work/repo',
      claudeConfigDir: '/account',
      providerSessionId: 'fresh-id',
      resumeLeafUuid: null,
      resumesTranscript: false,
      continuesChain: false
    }),
    openConnection
  })
  await expect(
    adapter.acquire({
      identity: {
        sessionId: 'session',
        workspaceId: 'workspace',
        hostId: 'local',
        agent: 'claude',
        providerHandle: null
      },
      fence: 1,
      spawnToken: 'ephemeral',
      evidenceLaunch: { observe }
    })
  ).rejects.toThrow('startup trust')
  expect(observe).toHaveBeenCalledWith({
    launchFingerprint: expect.any(String),
    transport: 'claude-sdk-mcp',
    resuming: false
  })
  expect(openConnection).not.toHaveBeenCalled()
})
it('confirms only the initialized native registration and keeps provider permissions unchanged', async () => {
  const { fakeClaude, identityFor, PROVIDER_SESSION_ID } =
    await import('./claude-structured-session-test-support')
  const { conversationEvidenceToolDefinition } =
    await import('../native-chat/conversations/conversation-evidence-tool-contract')
  const native = fakeClaude({ initProof: 'none' })
  const confirm = vi.fn()
  const permit = {
    assertBeforeSpawn: vi.fn(),
    registration: {
      close: async () => {},
      definition: conversationEvidenceToolDefinition(),
      invoke: async () => ({}),
      confirm
    }
  }
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      contextDeliveryVersion: '2.1.309',
      options: { permissionMode: 'default' },
      cwd: '/work/repo',
      claudeConfigDir: '/account',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      continuesChain: false
    }),
    readProcessStartTime: async () => 1,
    openConnection: async (launch, handlers) => {
      expect(launch.evidence).toBe(permit)
      expect(launch.options.permissionMode).toBe('default')
      const connection = await native.openConnection(launch, handlers)
      return { ...connection, evidenceToolRegistered: async () => true }
    }
  })
  try {
    const acquisition = await adapter.acquire({
      identity: identityFor(),
      fence: 1,
      spawnToken: 'ephemeral',
      evidenceLaunch: { observe: () => permit }
    })
    expect(confirm).not.toHaveBeenCalled()
    await adapter.open({
      sessionId: 'session-1',
      fence: 1,
      acquisitionGeneration: acquisition.acquisitionGeneration,
      signal: new AbortController().signal
    })
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeSessionId: PROVIDER_SESSION_ID,
        acquisitionGeneration: acquisition.acquisitionGeneration,
        transport: 'claude-sdk-mcp',
        runtimeFence: 1
      })
    )
  } finally {
    await adapter.closeAll()
  }
})
