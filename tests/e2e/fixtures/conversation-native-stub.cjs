// Fixture-only native protocol peer. Never invokes a model, account, tool or network service.
const { randomUUID } = require('node:crypto')
const { appendFileSync } = require('node:fs')
const { join } = require('node:path')
const { createInterface } = require('node:readline')
const { afterAcceptanceRelease } = require('./conversation-stub-control.cjs')
const { verifyOpenCodeEvidence } = require('./conversation-opencode-mcp.cjs')
const [agent, directory, ...args] = process.argv.slice(2)
const responseText = process.env.ORCA_E2E_CONVERSATION_REPLY ?? 'Fixture response.'
if (!['codex', 'opencode'].includes(agent) || !directory) {
  throw new Error('Expected fixture agent and isolated evidence directory')
}
const log = (entry) =>
  appendFileSync(join(directory, `${agent}.jsonl`), `${JSON.stringify(entry)}\n`)
log({ kind: 'launch', args, pid: process.pid })
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(agent === 'codex' ? 'codex-cli 0.159.0-alpha.3\n' : '1.19.4\n')
  process.exit(0)
}
const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)
const reply = (frame, result) => write({ jsonrpc: '2.0', id: frame.id, result })
const notify = (method, params) => write({ jsonrpc: '2.0', method, params })
let nativeId = randomUUID()
let turnId = null
let pending = null
function finish(status = 'completed') {
  if (!pending) {
    return
  }
  const frame = pending
  pending = null
  if (agent === 'codex') {
    notify('item/completed', {
      threadId: nativeId,
      turnId,
      item: { type: 'agentMessage', id: randomUUID(), text: responseText }
    })
    notify('thread/status/changed', { threadId: nativeId, status: { type: 'idle' } })
    notify('turn/completed', { threadId: nativeId, turn: { id: turnId, status } })
  } else {
    reply(frame, { stopReason: status === 'completed' ? 'end_turn' : 'cancelled' })
  }
}
function codex(frame) {
  const params = frame.params ?? {}
  switch (frame.method) {
    case 'initialize':
      return reply(frame, { userAgent: 'codex_cli_rs/0.159.0-alpha.3' })
    case 'initialized':
      return
    case 'thread/start':
    case 'thread/resume':
      nativeId = params.threadId ?? nativeId
      return reply(frame, { thread: { id: nativeId, turns: [] }, model: 'fixture-model' })
    case 'thread/read':
      return reply(frame, { thread: { id: nativeId, turns: [] } })
    case 'thread/loaded/list':
      return reply(frame, { data: [nativeId], nextCursor: null })
    case 'model/list':
      return reply(frame, {
        data: [
          {
            id: 'fixture-model',
            model: 'fixture-model',
            displayName: 'Fixture model',
            isDefault: true,
            supportedReasoningEfforts: []
          }
        ],
        nextCursor: null
      })
    case 'account/read':
      return reply(frame, { account: null, requiresOpenaiAuth: false })
    case 'account/rateLimits/read':
      return reply(frame, { rateLimits: null })
    case 'config/read':
      return reply(frame, { config: {}, origins: {}, layers: [] })
    case 'skills/list':
      return reply(frame, { data: [] })
    case 'mcpServerStatus/list':
      return reply(frame, { data: [], nextCursor: null })
    case 'turn/start': {
      turnId = randomUUID()
      pending = frame
      log({ kind: 'input', nativeId, clientId: params.clientUserMessageId, input: params.input })
      reply(frame, { turn: { id: turnId, status: 'inProgress' } })
      notify('turn/started', { threadId: nativeId, turn: { id: turnId, status: 'inProgress' } })
      afterAcceptanceRelease(directory, agent, () => {
        notify('item/completed', {
          threadId: nativeId,
          turn: { id: turnId },
          item: {
            type: 'userMessage',
            id: randomUUID(),
            clientId: params.clientUserMessageId,
            content: params.input ?? []
          }
        })
        if (!JSON.stringify(params.input).includes('FIXTURE_HOLD_TURN')) {
          finish()
        }
      })
      return
    }
    case 'turn/interrupt':
      reply(frame, {})
      return finish('interrupted')
    default:
      return unsupported(frame)
  }
}
async function opencode(frame) {
  const params = frame.params ?? {}
  switch (frame.method) {
    case 'initialize':
      return reply(frame, {
        protocolVersion: 1,
        agentInfo: { name: 'opencode', version: '1.19.4' },
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true },
          promptCapabilities: { embeddedContext: true }
        }
      })
    case 'session/new':
    case 'session/load':
      await verifyOpenCodeEvidence(params.mcpServers, log)
      nativeId = params.sessionId ?? nativeId
      return reply(frame, {
        ...(frame.method === 'session/new' ? { sessionId: nativeId } : {}),
        models: {
          currentModelId: 'fixture-model',
          availableModels: [{ modelId: 'fixture-model', name: 'Fixture model' }]
        }
      })
    case 'session/set_model':
    case 'session/set_mode':
      return reply(frame, {})
    case 'session/prompt':
      pending = frame
      log({
        kind: 'input',
        nativeId,
        clientId: params._meta?.promptId,
        requestId: frame.id,
        input: params.prompt
      })
      notify('session/update', {
        sessionId: nativeId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: responseText }
        },
        ...(params._meta ? { _meta: params._meta } : {})
      })
      afterAcceptanceRelease(directory, agent, () => {
        if (!JSON.stringify(params.prompt).includes('FIXTURE_HOLD_TURN')) {
          finish()
        }
      })
      return
    case 'session/cancel':
      return finish('interrupted')
    default:
      return unsupported(frame)
  }
}
function unsupported(frame) {
  if (frame.id !== undefined) {
    write({
      jsonrpc: '2.0',
      id: frame.id,
      error: { code: -32601, message: `Fixture does not implement ${frame.method}` }
    })
  }
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line)
  log({ kind: 'request', frame })
  if (agent === 'codex') {
    codex(frame)
  } else {
    void opencode(frame).catch(() =>
      write({
        jsonrpc: '2.0',
        id: frame.id,
        error: { code: -32603, message: 'Fixture evidence negotiation failed' }
      })
    )
  }
})
