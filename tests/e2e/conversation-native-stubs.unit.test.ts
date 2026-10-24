import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

it.each(['codex', 'opencode'] as const)(
  'the %s subprocess fixture preserves native identity and correlates exactly one input',
  async (agent) => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-conversation-stub-'))
    directories.push(directory)
    const input =
      agent === 'codex'
        ? [
            { id: 1, method: 'initialize', params: {} },
            { id: 2, method: 'thread/resume', params: { threadId: 'retained-native' } },
            {
              id: 3,
              method: 'turn/start',
              params: {
                threadId: 'retained-native',
                clientUserMessageId: 'exact-trigger',
                input: [{ type: 'text', text: 'Keep the final Unicode constraint: 終端' }]
              }
            }
          ]
        : [
            { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } },
            {
              jsonrpc: '2.0',
              id: 2,
              method: 'session/load',
              params: { sessionId: 'retained-native' }
            },
            {
              jsonrpc: '2.0',
              id: 3,
              method: 'session/prompt',
              params: {
                sessionId: 'retained-native',
                prompt: [{ type: 'text', text: 'Keep the final Unicode constraint: 終端' }],
                _meta: { promptId: 'exact-trigger' }
              }
            }
          ]
    const result = await runProcess({
      program: process.execPath,
      args: [resolve('tests/e2e/fixtures/conversation-native-stub.cjs'), agent, directory],
      input: `${input.map((frame) => JSON.stringify(frame)).join('\n')}\n`,
      timeoutMs: 5000,
      maxOutputBytes: 64 * 1024
    })
    expect(result.code, result.stderr).toBe(0)
    const frames: unknown[] = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    if (agent === 'codex') {
      expect(frames).toContainEqual(
        expect.objectContaining({
          id: 1,
          result: expect.objectContaining({ userAgent: 'codex_cli_rs/0.159.0-alpha.3' })
        })
      )
      expect(frames).toContainEqual(
        expect.objectContaining({
          method: 'item/completed',
          params: expect.objectContaining({
            threadId: 'retained-native',
            item: expect.objectContaining({ clientId: 'exact-trigger' })
          })
        })
      )
    } else {
      expect(frames).toContainEqual(
        expect.objectContaining({ id: 1, result: expect.objectContaining({ protocolVersion: 1 }) })
      )
      expect(frames).toContainEqual(
        expect.objectContaining({ id: 3, result: { stopReason: 'end_turn' } })
      )
    }
    expect(
      frames.filter(
        (frame) => typeof frame === 'object' && frame !== null && 'id' in frame && frame.id === 3
      )
    ).toHaveLength(1)
  }
)

it.each(['codex', 'opencode'] as const)(
  'the %s fixture records held input without fabricating acceptance',
  async (agent) => {
    const { writeFile, readFile } = await import('node:fs/promises')
    const directory = await mkdtemp(join(tmpdir(), 'orca-conversation-held-'))
    directories.push(directory)
    await writeFile(join(directory, `${agent}.hold`), '')
    const params =
      agent === 'codex'
        ? { clientUserMessageId: 'held', input: [{ type: 'text', text: 'trigger' }] }
        : { prompt: [{ type: 'text', text: 'trigger' }], _meta: { promptId: 'held' } }
    const result = await runProcess({
      program: process.execPath,
      args: [resolve('tests/e2e/fixtures/conversation-native-stub.cjs'), agent, directory],
      input: `${JSON.stringify({
        id: 9,
        method: agent === 'codex' ? 'turn/start' : 'session/prompt',
        params
      })}\n`,
      timeoutMs: 5000,
      maxOutputBytes: 65536
    })
    expect(result.code, result.stderr).toBe(0)
    const lines = result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    expect(
      lines.some(
        (frame) => frame.method === 'item/completed' && frame.params?.item?.type === 'userMessage'
      )
    ).toBe(false)
    expect(lines.some((frame) => frame.id === 9 && frame.result?.stopReason)).toBe(false)
    const logged = (await readFile(join(directory, `${agent}.jsonl`), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    expect(logged.filter((frame) => frame.kind === 'input')).toHaveLength(1)
  }
)

it('Claude reviewed version is fixture opt-in and the ordinary fixture remains unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-conversation-claude-'))
  directories.push(directory)
  const args = [
    resolve('tests/e2e/fixtures/structured-claude-stub.cjs'),
    join(directory, 'launches.jsonl'),
    '--version'
  ]
  const ordinary = await runProcess({
    program: process.execPath,
    args,
    timeoutMs: 5000,
    maxOutputBytes: 65536
  })
  const conversation = await runProcess({
    program: process.execPath,
    args,
    env: { ...process.env, ORCA_E2E_CONVERSATION_STUB_DIRECTORY: directory },
    timeoutMs: 5000,
    maxOutputBytes: 65536
  })
  expect(ordinary.stdout).toContain('2.1.280')
  expect(conversation.stdout).toContain('2.1.309')
})

it.each([
  ['SDK initialization', undefined],
  [
    'legacy SDK config',
    JSON.stringify({ mcpServers: { 'orca-conversation-evidence': { type: 'sdk' } } })
  ]
])('Claude %s reports only successfully negotiated SDK tools', async (_, config) => {
  const frames = await claudeMcpFrames(config, 'valid')
  expect(frames).toContainEqual(
    expect.objectContaining({
      request: expect.objectContaining({
        subtype: 'mcp_message',
        message: expect.objectContaining({ method: 'initialize' })
      })
    })
  )
  expect(frames).toContainEqual(
    expect.objectContaining({
      request: expect.objectContaining({
        subtype: 'mcp_message',
        message: expect.objectContaining({ method: 'tools/list' })
      })
    })
  )
  expect(frames).toContainEqual({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'status',
      response: {
        mcpServers: [
          {
            name: 'orca-conversation-evidence',
            source: 'sdk',
            status: 'connected',
            tools: [{ name: 'orca_conversation_evidence' }]
          }
        ]
      }
    }
  })
})

it.each(['error', 'malformed', 'foreign', 'absent', 'init-error', 'init-malformed'] as const)(
  'Claude never manufactures evidence registration from %s handshake evidence',
  async (outcome) => {
    const frames = await claudeMcpFrames(undefined, outcome)
    expect(frames).toContainEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'status',
        response: { mcpServers: [] }
      }
    })
  }
)

async function claudeMcpFrames(config: string | undefined, outcome: string): Promise<unknown[]> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-claude-mcp-'))
  directories.push(directory)
  const reply = (requestId: string, id: number, result: unknown) => ({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: { mcp_response: { jsonrpc: '2.0', id, result } }
    }
  })
  const input = [
    {
      type: 'control_request',
      request_id: 'init',
      request: {
        subtype: 'initialize',
        sdkMcpServers: config || outcome === 'absent' ? [] : ['orca-conversation-evidence']
      }
    },
    { type: 'control_request', request_id: 'status', request: { subtype: 'mcp_status' } },
    outcome === 'init-error'
      ? {
          type: 'control_response',
          response: { subtype: 'error', request_id: 'fixture-mcp-initialize', error: 'unavailable' }
        }
      : reply('fixture-mcp-initialize', 1, {
          protocolVersion: outcome === 'init-malformed' ? 'invalid-protocol' : '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'orca-conversation-evidence', version: '1' }
        }),
    outcome === 'error'
      ? {
          type: 'control_response',
          response: { subtype: 'error', request_id: 'fixture-mcp-tools', error: 'unavailable' }
        }
      : reply(
          'fixture-mcp-tools',
          outcome === 'foreign' ? 99 : 2,
          outcome === 'malformed'
            ? { tools: 'invented' }
            : { tools: [{ name: 'orca_conversation_evidence' }] }
        )
  ]
  const result = await runProcess({
    program: process.execPath,
    args: [
      resolve('tests/e2e/fixtures/structured-claude-stub.cjs'),
      join(directory, 'launch.jsonl'),
      ...(config ? ['--mcp-config', config] : [])
    ],
    env: { ...process.env, ORCA_E2E_CONVERSATION_STUB_DIRECTORY: directory },
    input: `${input.map((frame) => JSON.stringify(frame)).join('\n')}\n`,
    timeoutMs: 5000,
    maxOutputBytes: 65536
  })
  expect(result.code, result.stderr).toBe(0)
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}
