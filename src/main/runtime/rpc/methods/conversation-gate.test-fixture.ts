import { recordingStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import type { RpcRequest } from '../core'
import { vi } from 'vitest'
export const conversationMembership = vi.fn<
  (sessionId: string) => { conversationId: string } | null
>(() => null)
export function createConversationGateTestStore() {
  conversationMembership.mockReset().mockReturnValue(null)
  return {
    listRecords: vi.fn(() => [
      {
        sessionId: 'session-alpha',
        location: { workspaceId: 'workspace-1', executionHostId: 'local' }
      }
    ]),
    getOperationRow: vi.fn(() => null),
    getRecord: vi.fn(() => null),
    conversations: { membership: conversationMembership }
  }
}

export function conversationGateTestRequest(method: string, params: unknown): RpcRequest {
  return { id: 'request-1', authToken: 'token', method, params }
}

export function installConversationGateTestDependencies(
  host: Record<string, ReturnType<typeof vi.fn>>
): void {
  Reflect.set(host, 'deps', {
    logger: recordingStructuredAgentSessionLogger().logger,
    store: createConversationGateTestStore()
  })
}
