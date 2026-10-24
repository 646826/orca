async function verifyOpenCodeEvidence(servers, log) {
  const descriptor = servers?.find((server) => server.name === 'orca-conversation-evidence')
  if (!descriptor) {
    return
  }
  const url = new URL(descriptor.url)
  if (
    descriptor.type !== 'http' ||
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/evidence' ||
    url.username ||
    url.password
  ) {
    throw new Error('Expected the isolated loopback evidence server')
  }
  const call = async (id, method, params) => {
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...Object.fromEntries(descriptor.headers.map(({ name, value }) => [name, value]))
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    })
    if (!response.ok) {
      throw new Error('Evidence transport refused')
    }
    const frame = await response.json()
    if (frame.jsonrpc !== '2.0' || frame.id !== id || frame.error || !frame.result) {
      throw new Error('Unverified evidence protocol response')
    }
    return frame.result
  }
  const initialized = await call(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'orca-scripted-opencode-peer', version: '1' }
  })
  if (
    initialized.protocolVersion !== '2024-11-05' ||
    !initialized.capabilities?.tools ||
    typeof initialized.serverInfo?.name !== 'string'
  ) {
    throw new Error('Unverified evidence initialization')
  }
  const listed = await call(2, 'tools/list', {})
  if (
    !Array.isArray(listed.tools) ||
    !listed.tools.every((tool) => typeof tool?.name === 'string') ||
    !listed.tools.some((tool) => tool.name === 'orca_conversation_evidence')
  ) {
    throw new Error('Evidence read tool unavailable')
  }
  log({
    kind: 'mcp-negotiated',
    methods: ['initialize', 'tools/list'],
    tools: listed.tools.map((tool) => tool.name)
  })
}
module.exports = { verifyOpenCodeEvidence }
