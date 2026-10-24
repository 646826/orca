import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { expect, it, vi } from 'vitest'
import { createClaudeStructuredQuery } from './claude-agent-sdk-query'
import { conversationEvidenceToolDefinition } from '../native-chat/conversations/conversation-evidence-tool-contract'
it('rechecks approval in the actual SDK spawn callback after a deferred invocation', async () => {
  let spawn: Options['spawnClaudeCodeProcess']
  let revoked = false
  const processSpawn = vi.fn(() => {
    throw new Error('unexpected process spawn')
  })
  const permit = {
    assertBeforeSpawn() {
      if (revoked) {
        throw new Error('approval revoked')
      }
    },
    registration: {
      definition: conversationEvidenceToolDefinition(),
      confirm: () => {},
      close: async () => {},
      invoke: async () => ({})
    }
  }
  await expect(
    createClaudeStructuredQuery(
      {
        pathToClaudeCodeExecutable: 'claude',
        options: {},
        cwd: '/work',
        env: {},
        evidence: permit,
        evidenceEnv: {}
      },
      {},
      processSpawn,
      (input) => {
        spawn = input.options?.spawnClaudeCodeProcess
        throw new Error('SDK deferred query')
      }
    )
  ).rejects.toThrow('SDK deferred query')
  revoked = true
  expect(() =>
    spawn?.({ command: 'claude', args: [], env: {}, signal: new AbortController().signal })
  ).toThrow('approval revoked')
  expect(processSpawn).not.toHaveBeenCalled()
})
