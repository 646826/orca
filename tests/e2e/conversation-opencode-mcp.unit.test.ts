import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { createAcpConversationEvidenceServer } from '../../src/main/acp/acp-conversation-evidence-server'
import { conversationEvidenceToolDefinition } from '../../src/main/native-chat/conversations/conversation-evidence-tool-contract'
import type { McpServerHttp } from '../../src/main/acp/generated/acp-protocol.generated'

async function runPeer(descriptor: McpServerHttp) {
  const directory = await mkdtemp(join(tmpdir(), 'orca-opencode-mcp-'))
  try {
    const frames = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: directory, mcpServers: [descriptor] }
      }
    ]
    const result = await runProcess({
      program: process.execPath,
      args: [resolve('tests/e2e/fixtures/conversation-native-stub.cjs'), 'opencode', directory],
      input: `${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`,
      timeoutMs: 5000,
      maxOutputBytes: 65536
    })
    expect(result.code, result.stderr).toBe(0)
    return {
      frames: result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line): unknown => JSON.parse(line)),
      observations: (await readFile(join(directory, 'opencode.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line))
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

it('the native OpenCode peer negotiates the actual read-only MCP server before opening a session', async () => {
  const invoke = vi.fn()
  const server = await createAcpConversationEvidenceServer({
    definition: conversationEvidenceToolDefinition(),
    confirm: vi.fn(),
    invoke,
    close: vi.fn(async () => {})
  })
  try {
    const result = await runPeer(server.descriptor)
    expect(result.frames).toContainEqual(
      expect.objectContaining({
        id: 2,
        result: expect.objectContaining({ sessionId: expect.any(String) })
      })
    )
    expect(result.observations).toContainEqual({
      kind: 'mcp-negotiated',
      methods: ['initialize', 'tools/list'],
      tools: ['orca_conversation_evidence']
    })
    expect(invoke).not.toHaveBeenCalled()
  } finally {
    await server.close()
  }
})
it('the native peer refuses session opening when the evidence server rejects its credentials', async () => {
  const server = await createAcpConversationEvidenceServer({
    definition: conversationEvidenceToolDefinition(),
    confirm: vi.fn(),
    invoke: vi.fn(),
    close: vi.fn(async () => {})
  })
  try {
    const result = await runPeer({
      ...server.descriptor,
      headers: [{ name: 'Authorization', value: 'Bearer wrong' }]
    })
    expect(result.frames).toContainEqual(
      expect.objectContaining({ id: 2, error: expect.any(Object) })
    )
    expect(result.observations).not.toContainEqual(
      expect.objectContaining({ kind: 'mcp-negotiated' })
    )
  } finally {
    await server.close()
  }
})
it.each(['malformed', 'foreign-id', 'missing-tool', 'error'] as const)(
  'the native peer refuses %s MCP evidence',
  async (failure) => {
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk))
      }
      const frame = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: failure === 'foreign-id' ? 99 : frame.id,
          ...(failure === 'error'
            ? { error: { code: -32603, message: 'unavailable' } }
            : {
                result:
                  frame.method === 'initialize'
                    ? {
                        protocolVersion: '2024-11-05',
                        capabilities: { tools: {} },
                        serverInfo: { name: 'test', version: '1' }
                      }
                    : { tools: failure === 'malformed' ? 'invalid' : [{ name: 'wrong-tool' }] }
              })
        })
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('Missing local fixture port')
      }
      const result = await runPeer({
        type: 'http',
        name: 'orca-conversation-evidence',
        url: `http://127.0.0.1:${address.port}/evidence`,
        headers: []
      })
      expect(result.frames).toContainEqual(
        expect.objectContaining({ id: 2, error: expect.any(Object) })
      )
      expect(result.observations).not.toContainEqual(
        expect.objectContaining({ kind: 'mcp-negotiated' })
      )
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
)
