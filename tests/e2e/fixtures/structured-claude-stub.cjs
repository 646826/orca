// Stand-in for Claude Code's stream-json control protocol: answers `initialize`, reports init and
// runs each prompt as a short turn, so a structured chat works without the real CLI. Launched only
// through a generated wrapper whose first argument is the launch log the spec reads back.
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const { join } = require('node:path')
const { afterAcceptanceRelease } = require('./conversation-stub-control.cjs')
const conversationDirectory = process.env.ORCA_E2E_CONVERSATION_STUB_DIRECTORY

const [launchLog, ...args] = process.argv.slice(2)
fs.appendFileSync(launchLog, `${JSON.stringify({ pid: process.pid, args })}\n`)

if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(`${conversationDirectory ? '2.1.309' : '2.1.280'} (Claude Code)\n`)
  process.exit(0)
}

function argValue(name) {
  const joined = args.find((arg) => arg.startsWith(`${name}=`))
  if (joined) {
    return joined.slice(name.length + 1)
  }
  const index = args.indexOf(name)
  return index !== -1 ? args[index + 1] : undefined
}

const sessionId = argValue('--session-id') ?? argValue('--resume') ?? randomUUID()
const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)
const initializeResponse = {
  commands: [],
  models: [{ value: 'default', displayName: 'Default', description: '' }],
  account: {},
  output_style: 'default',
  available_output_styles: ['default']
}

// A prompt containing "slow" runs until it is interrupted.
const TURN_MS = 500
const SLOW_TURN_MS = 60_000
let turnTimer = null

function startTurn(frame) {
  if (conversationDirectory) {
    fs.appendFileSync(
      join(conversationDirectory, 'claude.jsonl'),
      `${JSON.stringify({
        kind: 'input',
        nativeId: sessionId,
        clientId: frame.uuid,
        input: frame.message?.content
      })}\n`
    )
  }
  afterAcceptanceRelease(conversationDirectory, 'claude', () => {
    deliverTurn(frame)
  })
}

function deliverTurn(frame) {
  // The CLI's --replay-user-messages echo, which opens the turn.
  write({ ...frame, isReplay: true })
  const text = JSON.stringify(frame.message ?? '')
  const slow = text.includes('slow') || text.includes('FIXTURE_HOLD_TURN')
  turnTimer = setTimeout(
    () => {
      turnTimer = null
      write({
        type: 'assistant',
        uuid: randomUUID(),
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          id: randomUUID(),
          role: 'assistant',
          model: 'claude-fake',
          content: [{ type: 'text', text: 'Stub reply.' }]
        }
      })
      write({
        type: 'result',
        subtype: 'success',
        uuid: randomUUID(),
        session_id: sessionId,
        is_error: false,
        terminal_reason: 'completed',
        result: 'Stub reply.'
      })
    },
    slow ? SLOW_TURN_MS : TURN_MS
  )
}

function interruptTurn() {
  if (!turnTimer) {
    return
  }
  clearTimeout(turnTimer)
  turnTimer = null
  write({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    session_id: sessionId,
    parent_tool_use_id: null
  })
}

const evidenceServer = 'orca-conversation-evidence'
let mcpState = 'absent'
let mcpTools = []
let mcpTimer
const pendingStatuses = []
const reply = (frame, response) =>
  write({
    type: 'control_response',
    response: { subtype: 'success', request_id: frame.request_id, response }
  })
const mcpStatus = () => ({
  mcpServers:
    mcpState === 'connected'
      ? [{ name: evidenceServer, source: 'sdk', status: 'connected', tools: mcpTools }]
      : []
})
function finishMcp(state) {
  mcpState = state
  clearTimeout(mcpTimer)
  for (const frame of pendingStatuses.splice(0)) {
    reply(frame, mcpStatus())
  }
}
function mcpMessage(requestId, message) {
  write({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'mcp_message', server_name: evidenceServer, message }
  })
}
function beginMcp(request) {
  let configured = false
  try {
    configured =
      JSON.parse(argValue('--mcp-config') ?? '{}').mcpServers?.[evidenceServer]?.type === 'sdk'
  } catch {}
  const announced =
    Array.isArray(request.sdkMcpServers) && request.sdkMcpServers.includes(evidenceServer)
  if (!conversationDirectory || (!announced && !configured)) {
    return
  }
  mcpState = 'initializing'
  mcpTimer = setTimeout(() => finishMcp('failed'), 2000)
  mcpMessage('fixture-mcp-initialize', {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'orca-scripted-native-peer', version: '1' }
    }
  })
}
function acceptMcpResponse(frame) {
  const envelope = frame.response
  const initializing =
    envelope?.request_id === 'fixture-mcp-initialize' && mcpState === 'initializing'
  const listing = envelope?.request_id === 'fixture-mcp-tools' && mcpState === 'listing'
  if (!initializing && !listing) {
    return
  }
  const message = envelope.response?.mcp_response
  if (
    envelope.subtype !== 'success' ||
    message?.jsonrpc !== '2.0' ||
    message.id !== (initializing ? 1 : 2) ||
    message.error ||
    !message.result
  ) {
    finishMcp('failed')
    return
  }
  if (initializing) {
    if (
      message.result.protocolVersion !== '2024-11-05' ||
      typeof message.result.serverInfo?.name !== 'string' ||
      !message.result.capabilities?.tools
    ) {
      finishMcp('failed')
      return
    }
    mcpState = 'listing'
    mcpMessage('fixture-mcp-initialized', { jsonrpc: '2.0', method: 'notifications/initialized' })
    mcpMessage('fixture-mcp-tools', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    return
  }
  if (
    !Array.isArray(message.result.tools) ||
    !message.result.tools.every((tool) => tool && typeof tool.name === 'string')
  ) {
    finishMcp('failed')
    return
  }
  mcpTools = message.result.tools.map((tool) => ({ name: tool.name }))
  finishMcp('connected')
}

let buffer = ''
let initSent = false
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += String(chunk)
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    let frame
    try {
      frame = line ? JSON.parse(line) : null
    } catch {
      frame = null
    }
    if (frame?.type === 'user') {
      startTurn(frame)
      continue
    }
    if (frame?.type === 'control_response') {
      acceptMcpResponse(frame)
      continue
    }
    if (frame?.type !== 'control_request') {
      continue
    }
    const subtype = frame.request?.subtype
    if (subtype === 'interrupt') {
      interruptTurn()
    }
    if (subtype === 'mcp_status' && conversationDirectory) {
      if (mcpState === 'initializing' || mcpState === 'listing') {
        pendingStatuses.push(frame)
      } else {
        reply(frame, mcpStatus())
      }
      continue
    }
    reply(frame, subtype === 'initialize' ? initializeResponse : {})
    if (subtype === 'initialize' && !initSent) {
      initSent = true
      beginMcp(frame.request)
      write({
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        uuid: randomUUID(),
        model: 'claude-fake',
        cwd: process.cwd(),
        tools: [],
        mcp_servers: [],
        permissionMode: 'default',
        slash_commands: [],
        apiKeySource: 'none',
        output_style: 'default'
      })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
