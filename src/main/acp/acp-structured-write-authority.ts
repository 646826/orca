import type { ContentBlock } from './generated/acp-protocol.generated'
import type { AcpStructuredConnection } from './acp-structured-connection'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

export type AcpStructuredSend = {
  clientMessageId: string
  requireExactOrigin?: true
  prompt: ContentBlock[]
  requestedAt: number
  beforeWrite?: Parameters<AcpStructuredConnection['prompt']>[2]
}

export function acpDispatchWriteAuthority(
  input: Parameters<StructuredAgentSessionAdapter['dispatch']>[0]
): AcpStructuredSend['beforeWrite'] {
  if (!input.beforeContextDispatch && !input.beforeDispatch && !input.signal) {
    return undefined
  }
  return async (params) => {
    await input.beforeContextDispatch?.({ transport: 'acp', payload: params })
    await input.beforeDispatch?.()
    input.signal?.throwIfAborted()
  }
}
