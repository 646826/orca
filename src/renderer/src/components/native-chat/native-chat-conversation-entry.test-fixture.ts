import type { ConversationSurfaceSnapshot } from '../../../../shared/conversation-surface-rpc'
export const entrySnapshot = {
  conversation: {
    conversationId: 'c',
    revision: 3,
    contextGeneration: 1,
    activationFence: 2,
    activeSegmentId: 'a',
    pendingOperationKey: 'op',
    location: {
      executionHostId: 'local',
      workspaceId: 'w',
      workspaceKind: 'folder',
      wslDistro: null
    }
  },
  active: {
    sessionId: 'a',
    agent: 'claude',
    agentLabel: 'Claude Code',
    profile: { state: 'unknown' },
    authenticatedAccount: { state: 'unknown' },
    host: { id: 'local', label: 'local' },
    workspace: { id: 'w', label: 'w', kind: 'folder', wslDistro: null },
    permissions: { selected: null, applied: null, state: 'unverified' },
    startupTrust: 'unobserved',
    transport: 'unverified'
  },
  selected: null,
  surface: null,
  operation: {
    operationKey: 'op',
    conversationId: 'c',
    candidateSegmentId: 'b',
    nativeBindingGeneration: 1,
    sourceBoundaryCount: 1,
    candidateBoundaryCount: 1,
    version: 1,
    phase: 'prepared',
    targetSessionId: 'b',
    contextGeneration: 1,
    activationFence: 2
  }
} satisfies ConversationSurfaceSnapshot
