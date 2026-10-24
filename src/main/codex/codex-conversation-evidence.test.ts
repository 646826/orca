import { codexEvidenceLaunchFingerprint } from './codex-conversation-evidence'
import { ConversationEvidenceStartupTrustRequiredError } from '../native-chat/conversations/conversation-evidence-launch-gate'
import { expect, it, vi } from 'vitest'
import {
  adapterFor,
  fakeCodex,
  identityFor,
  acquireReadyCodexForTest
} from './codex-structured-session-adapter-fixture'
import { conversationEvidenceToolDefinition } from '../native-chat/conversations/conversation-evidence-tool-contract'
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

function fixture(version = '0.159.0-alpha.3') {
  const codex = fakeCodex({ initialize: () => ({ userAgent: `codex_cli_rs/${version}` }) })
  const adapter = adapterFor(codex)
  const registration = {
    definition: conversationEvidenceToolDefinition(),
    close: vi.fn(async () => {}),
    confirm: vi.fn(),
    invoke: vi.fn(async (_raw: unknown, _signal: AbortSignal) => ({ sources: [] }))
  }
  const permit = { registration, assertBeforeSpawn: vi.fn() }
  const observe = vi.fn(() => permit)
  const input: StructuredAgentSessionAcquireInput = {
    identity: { ...identityFor('session-1'), providerHandle: null },
    fence: 1,
    spawnToken: 'token',
    evidenceLaunch: { observe }
  }
  return { codex, adapter, registration, permit, observe, input }
}
it('does not spawn while the exact launch still requires trust', async () => {
  const f = fixture()
  f.observe.mockImplementation(() => {
    throw new ConversationEvidenceStartupTrustRequiredError()
  })
  await expect(f.adapter.acquire(f.input)).rejects.toMatchObject({
    name: 'AgentSessionPreSpawnError',
    reason: 'conversationStartupTrustRequired'
  })
  expect(f.codex.connections).toHaveLength(0)
})
it('registers the reviewed dynamic tool on actual fresh thread/start before confirming ownership', async () => {
  const f = fixture()
  await acquireReadyCodexForTest(f.adapter, f.input)
  expect(f.observe).toHaveBeenCalledWith(
    expect.objectContaining({ transport: 'codex-dynamic-tool', resuming: false })
  )
  expect(f.permit.assertBeforeSpawn).toHaveBeenCalled()
  expect(
    f.codex.connections[0].calls.find((c) => c.method === 'thread/start')?.params
  ).toMatchObject({
    dynamicTools: [
      {
        type: 'function',
        name: 'orca_conversation_evidence',
        inputSchema: f.registration.definition.inputSchema
      }
    ]
  })
  expect(f.registration.confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      nativeSessionId: 'thread-abc',
      runtimeFence: 1,
      transport: 'codex-dynamic-tool'
    })
  )
  await f.adapter.closeSession('session-1')
  expect(f.registration.close).toHaveBeenCalledOnce()
})
it('refuses an unregistered retained native thread before spawning', async () => {
  const f = fixture()
  const adapter = adapterFor(f.codex, { resumeThreadId: 'retained' })
  await expect(adapter.acquire(f.input)).rejects.toMatchObject({
    name: 'AgentSessionPreSpawnError',
    cause: { reason: 'native-rebuild-required' }
  })
  expect(f.codex.connections).toHaveLength(0)
})
it('does not send dynamic thread/start for an unreviewed protocol version', async () => {
  const f = fixture('0.0.1')
  await expect(acquireReadyCodexForTest(f.adapter, f.input)).rejects.toThrow()
  expect(f.codex.connections[0].calls.some((c) => c.method === 'thread/start')).toBe(false)
  expect(f.registration.confirm).not.toHaveBeenCalled()
  await f.adapter.closeSession('session-1')
})

it('routes only the exact owned tool/thread and does not expose provider errors', async () => {
  const f = fixture()
  await acquireReadyCodexForTest(f.adapter, f.input)
  const connection = f.codex.connections[0]
  const params = {
    threadId: 'thread-abc',
    turnId: 'turn-1',
    callId: 'call-1',
    tool: 'orca_conversation_evidence',
    arguments: { action: 'list' }
  }
  connection.handlers.onServerRequest?.({ id: 1, method: 'item/tool/call', params })
  await vi.waitFor(() =>
    expect(connection.replies).toContainEqual({
      id: 1,
      result: { success: true, contentItems: [{ type: 'inputText', text: '{"sources":[]}' }] }
    })
  )
  connection.handlers.onServerRequest?.({
    id: 2,
    method: 'item/tool/call',
    params: { ...params, threadId: 'other-thread' }
  })
  expect(f.registration.invoke).toHaveBeenCalledTimes(1)
  expect(connection.replies.at(-1)).toMatchObject({ id: 2, result: { success: false } })
  f.registration.invoke.mockRejectedValueOnce(new Error('sensitive provider content'))
  connection.handlers.onServerRequest?.({ id: 3, method: 'item/tool/call', params })
  await vi.waitFor(() =>
    expect(connection.replies.at(-1)).toMatchObject({ id: 3, result: { success: false } })
  )
  expect(JSON.stringify(connection.replies)).not.toContain('sensitive provider content')
  await f.adapter.closeSession('session-1')
})
it('rechecks the permit immediately before spawning and preserves the typed refusal', async () => {
  const f = fixture()
  f.permit.assertBeforeSpawn
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw new Error('revoked')
    })
  await expect(f.adapter.acquire(f.input)).rejects.toMatchObject({
    name: 'AgentSessionPreSpawnError'
  })
  expect(f.codex.connections).toHaveLength(0)
})
it('releases pending registration when its first permit check refuses startup', async () => {
  const f = fixture()
  f.permit.assertBeforeSpawn.mockImplementation(() => {
    throw new Error('revoked')
  })
  await expect(f.adapter.acquire(f.input)).rejects.toMatchObject({
    name: 'AgentSessionPreSpawnError'
  })
  expect(f.codex.connections).toHaveLength(0)
  expect(f.registration.close).toHaveBeenCalledOnce()
})

it('aborts retained evidence reads on close and never sends a late successful tool result', async () => {
  const f = fixture()
  let finish!: (value: { sources: never[] }) => void
  f.registration.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await acquireReadyCodexForTest(f.adapter, f.input)
  const connection = f.codex.connections[0]
  connection.handlers.onServerRequest?.({
    id: 8,
    method: 'item/tool/call',
    params: {
      threadId: 'thread-abc',
      turnId: 'turn-1',
      callId: 'call-1',
      tool: 'orca_conversation_evidence',
      arguments: { action: 'list' }
    }
  })
  await vi.waitFor(() => expect(f.registration.invoke).toHaveBeenCalledOnce())
  const signal = f.registration.invoke.mock.calls[0][1]
  await f.adapter.closeSession('session-1')
  expect(signal.aborted).toBe(true)
  finish({ sources: [] })
  await Promise.resolve()
  expect(connection.replies).toEqual([])
})
it('binds effective launch settings but excludes only the opaque spawn token', () => {
  const launch = {
    command: 'codex',
    args: ['app-server'],
    cwd: '/workspace',
    codexHome: '/account',
    resumeThreadId: null,
    env: { ORCA_AGENT_SESSION_SPAWN_TOKEN: 'one', OTHER_CONFIG: 'one' }
  }
  const first = codexEvidenceLaunchFingerprint(launch)
  expect(
    codexEvidenceLaunchFingerprint({
      ...launch,
      env: { ...launch.env, ORCA_AGENT_SESSION_SPAWN_TOKEN: 'two' }
    })
  ).toBe(first)
  expect(
    codexEvidenceLaunchFingerprint({ ...launch, env: { ...launch.env, OTHER_CONFIG: 'two' } })
  ).not.toBe(first)
  expect(codexEvidenceLaunchFingerprint({ ...launch, commandEnv: { SETTING: 'two' } })).not.toBe(
    first
  )
  expect(codexEvidenceLaunchFingerprint({ ...launch, cwd: '/other' })).not.toBe(first)
})
