import { expect, it, vi } from 'vitest'
import {
  invokeClaudeConversationEvidence,
  hasClaudeConversationEvidenceRegistration
} from './claude-conversation-evidence'
import { conversationEvidenceToolDefinition } from '../native-chat/conversations/conversation-evidence-tool-contract'
it('uses the actual MCP call cancellation signal and returns no provider error content', async () => {
  const signal = new AbortController().signal
  const invoke = vi.fn(async () => ({ text: 'captured historical data' }))
  const registration = {
    close: async () => {},
    definition: conversationEvidenceToolDefinition(),
    confirm: () => undefined,
    invoke
  }
  expect(
    await invokeClaudeConversationEvidence(registration, { action: 'list' }, { signal })
  ).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ text: 'captured historical data' }) }]
  })
  expect(invoke).toHaveBeenCalledWith({ action: 'list' }, signal)
  invoke.mockRejectedValueOnce(new Error('sensitive provider error'))
  const failure = await invokeClaudeConversationEvidence(
    registration,
    { action: 'list' },
    { signal }
  )
  expect(JSON.stringify(failure)).not.toContain('sensitive')
  expect(failure.isError).toBe(true)
  await invokeClaudeConversationEvidence(registration, { action: 'list' }, {})
  expect(invoke).toHaveBeenCalledTimes(2)
})
it('requires the owned SDK registration and exact tool in native MCP status', () => {
  const server = {
    name: 'orca-conversation-evidence',
    status: 'connected' as const,
    source: 'sdk',
    tools: [{ name: conversationEvidenceToolDefinition().name }]
  }
  expect(hasClaudeConversationEvidenceRegistration([server])).toBe(true)
  expect(hasClaudeConversationEvidenceRegistration([{ ...server, source: 'project' }])).toBe(false)
  expect(hasClaudeConversationEvidenceRegistration([{ ...server, status: 'pending' }])).toBe(false)
  expect(hasClaudeConversationEvidenceRegistration([{ ...server, tools: [] }])).toBe(false)
})
