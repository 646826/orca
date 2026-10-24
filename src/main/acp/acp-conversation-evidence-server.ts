import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ConversationEvidencePendingRegistration } from '../native-chat/conversations/conversation-evidence-registration'
import type { McpServerHttp } from './generated/acp-protocol.generated'

async function readRequest(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > 16 * 1024) {
      throw new Error('Request too large')
    }
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function createAcpConversationEvidenceServer(
  registration: ConversationEvidencePendingRegistration
): Promise<{
  descriptor: McpServerHttp & { type: 'http' }
  close(): Promise<void>
}> {
  const token = randomBytes(32).toString('hex')
  const controller = new AbortController()
  const transports = new Set<StreamableHTTPServerTransport>()
  let host = ''
  const server = createServer((request, response) => {
    if (controller.signal.aborted) {
      response.writeHead(503).end()
      return
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end()
      return
    }
    if (request.headers.origin || request.headers.host !== host) {
      response.writeHead(403).end()
      return
    }
    if (request.url !== '/evidence' || request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }
    if (transports.size >= 4) {
      response.writeHead(429).end()
      return
    }
    const requestController = new AbortController()
    response.once('close', () => requestController.abort())
    request.once('aborted', () => requestController.abort())
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    })
    transports.add(transport)
    const protocol = new Server(
      { name: 'orca-conversation-evidence', version: '1.0.0' },
      { capabilities: { tools: {} } }
    )
    protocol.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [registration.definition] }))
    protocol.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
      if (call.params.name !== registration.definition.name) {
        throw new Error('Unknown evidence tool')
      }
      try {
        const value = await registration.invoke(
          call.params.arguments,
          AbortSignal.any([controller.signal, requestController.signal, extra.signal])
        )
        controller.signal.throwIfAborted()
        return { content: [{ type: 'text', text: JSON.stringify(value) }] }
      } catch {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Conversation evidence is unavailable.' }]
        }
      }
    })
    void (async () => {
      try {
        const body = await readRequest(request)
        controller.signal.throwIfAborted()
        await protocol.connect(transport)
        await transport.handleRequest(request, response, body)
      } catch {
        if (!response.headersSent) {
          response.writeHead(400).end()
        } else {
          response.end()
        }
      } finally {
        transports.delete(transport)
        await protocol.close().catch(() => {
          response.destroy()
        })
      }
    })()
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Evidence listener unavailable')
  }
  host = `127.0.0.1:${address.port}`
  let closing: Promise<void> | undefined
  return {
    descriptor: {
      type: 'http',
      name: 'orca-conversation-evidence',
      url: `http://${host}/evidence`,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }]
    },
    close() {
      closing ??= (async () => {
        controller.abort()
        const revoke = registration.close()
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()))
        server.closeAllConnections()
        const results = await Promise.allSettled([
          revoke,
          stopped,
          ...[...transports].map((transport) => transport.close())
        ])
        if (results.some((result) => result.status === 'rejected')) {
          throw new Error('Conversation evidence cleanup failed')
        }
      })()
      return closing
    }
  }
}
