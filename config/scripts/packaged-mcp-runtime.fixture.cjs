const assert = require('node:assert/strict')
const { createAcpConversationEvidenceServer } = require('./proof.cjs')
const Ajv = require('ajv')
const addFormats = require('ajv-formats')
const validator = new Ajv({ allErrors: true })
addFormats(validator)
const validate = validator.compile({
  definitions: { uri: { type: 'string', format: 'uri', minLength: 2 } },
  type: 'array',
  uniqueItems: true,
  items: { $ref: '#/definitions/uri' }
})
assert.equal(validate(['https://example.test/evidence']), true)
assert.equal(validate(['not a uri']), false)
assert.equal(validate(['https://example.test', 'https://example.test']), false)
assert.equal(validate(['é']), false)

;(async () => {
  let invoked = 0,
    closed = 0
  const server = await createAcpConversationEvidenceServer({
    definition: {
      name: 'read_evidence',
      description: 'Read evidence',
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string' } },
        required: ['action']
      }
    },
    invoke: async (args) => {
      invoked++
      assert.equal(args.action, 'list')
      return { sources: ['opaque-source'] }
    },
    close: async () => {
      closed++
    }
  })
  const authorization = Object.fromEntries(server.descriptor.headers.map((x) => [x.name, x.value]))
  const call = (method, params, headers = authorization) =>
    fetch(server.descriptor.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    })
  try {
    assert.equal((await call('tools/list', {}, {})).status, 401)
    assert.equal(
      (await call('tools/list', {}, { ...authorization, Origin: 'https://untrusted.example' }))
        .status,
      403
    )
    const initialized = await call('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'proof', version: '1' }
    })
    assert.equal(initialized.status, 200)
    assert.ok((await initialized.json()).result.protocolVersion)
    const list = await call('tools/list', {})
    assert.equal(list.status, 200)
    assert.equal((await list.json()).result.tools[0].name, 'read_evidence')
    const answer = await call('tools/call', {
      name: 'read_evidence',
      arguments: { action: 'list' }
    })
    assert.equal(answer.status, 200)
    assert.deepEqual((await answer.json()).result.content, [
      { type: 'text', text: '{"sources":["opaque-source"]}' }
    ])
    assert.equal(invoked, 1)
    console.log('packaged-evidence-http-ok')
  } finally {
    await server.close()
    await server.close()
    assert.equal(closed, 1)
  }
  await assert.rejects(() => call('tools/list', {}))
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
