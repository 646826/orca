import { describe, expect, it, vi } from 'vitest'
import { conversationEvidenceToolDefinition } from '../native-chat/conversations/conversation-evidence-tool-contract'
import { createAcpConversationEvidenceServer } from './acp-conversation-evidence-server'

describe('ACP conversation evidence HTTP boundary', () => {
  it('authenticates the native transport and routes only the registered read tool', async () => {
    const invoke = vi.fn(async () => ({ sources: ['opaque-source'] }))
    const server = await createAcpConversationEvidenceServer({
      definition: conversationEvidenceToolDefinition(),
      confirm: vi.fn(),
      invoke,
      close: vi.fn(async () => {})
    })
    const headers = Object.fromEntries(
      server.descriptor.headers.map(({ name, value }) => [name, value])
    )
    const call = (extra: Record<string, string>) =>
      fetch(server.descriptor.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...extra
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'orca_conversation_evidence', arguments: { action: 'list' } }
        })
      })
    try {
      expect((await call({})).status).toBe(401)
      expect((await call({ ...headers, Origin: 'https://untrusted.example' })).status).toBe(403)
      const response = await call(headers)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        result: {
          content: [{ type: 'text', text: JSON.stringify({ sources: ['opaque-source'] }) }]
        }
      })
      expect(invoke).toHaveBeenCalledTimes(1)
    } finally {
      await server.close()
    }
    await expect(call(headers)).rejects.toThrow()
  })
})

it('bounds request bytes and rejects wrong tools without exposing provider errors', async () => {
  const invoke = vi.fn(async () => {
    throw new Error('sensitive-path-or-provider-detail')
  })
  const close = vi.fn(async () => {})
  const server = await createAcpConversationEvidenceServer({
    definition: conversationEvidenceToolDefinition(),
    confirm: vi.fn(),
    invoke,
    close
  })
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...Object.fromEntries(server.descriptor.headers.map(({ name, value }) => [name, value]))
  }
  const request = (name: string) =>
    fetch(server.descriptor.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: { action: 'list' } }
      })
    })
  try {
    expect(
      (await fetch(server.descriptor.url, { method: 'POST', headers, body: ' '.repeat(20_000) }))
        .status
    ).toBe(400)
    const wrong = await request('workspace_write')
    expect(await wrong.json()).toHaveProperty('error')
    expect(invoke).not.toHaveBeenCalled()
    const failure = await request('orca_conversation_evidence')
    const body = await failure.text()
    expect(body).toContain('Conversation evidence is unavailable.')
    expect(body).not.toContain('sensitive-path')
  } finally {
    await server.close()
    await server.close()
  }
  expect(close).toHaveBeenCalledTimes(1)
})

it('bounds concurrent requests and aborts in-flight reads when the native owner closes', async () => {
  let admitted = 0
  let ready!: () => void
  const allAdmitted = new Promise<void>((resolve) => {
    ready = resolve
  })
  const signals: AbortSignal[] = []
  const registration = {
    definition: conversationEvidenceToolDefinition(),
    confirm: vi.fn(),
    close: vi.fn(async () => {}),
    invoke: vi.fn(async (_raw: unknown, signal: AbortSignal) => {
      signals.push(signal)
      if (++admitted === 4) {
        ready()
      }
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      )
    })
  }
  const server = await createAcpConversationEvidenceServer(registration)
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...Object.fromEntries(server.descriptor.headers.map(({ name, value }) => [name, value]))
  }
  const call = () =>
    fetch(server.descriptor.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'orca_conversation_evidence', arguments: { action: 'list' } }
      })
    }).then(
      (response) => response.status,
      () => 'closed'
    )
  const pending = [call(), call(), call(), call()]
  try {
    await allAdmitted
    expect(await call()).toBe(429)
    await server.close()
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(registration.close).toHaveBeenCalledTimes(1)
    await Promise.all(pending)
  } finally {
    await server.close()
  }
})

it('stops listening even when registration cleanup rejects', async () => {
  const server = await createAcpConversationEvidenceServer({
    definition: conversationEvidenceToolDefinition(),
    confirm: vi.fn(),
    invoke: vi.fn(),
    close: vi.fn(async () => {
      throw new Error('cleanup failed')
    })
  })
  await expect(server.close()).rejects.toThrow('Conversation evidence cleanup failed')
  await expect(fetch(server.descriptor.url)).rejects.toThrow()
})

it('cancels a read when the native HTTP caller disconnects', async () => {
  let entered!: () => void
  let cancelled!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const stopped = new Promise<void>((resolve) => {
    cancelled = resolve
  })
  const server = await createAcpConversationEvidenceServer({
    definition: conversationEvidenceToolDefinition(),
    confirm: vi.fn(),
    close: vi.fn(async () => {}),
    invoke: async (_raw, signal) => {
      entered()
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            cancelled()
            reject(new Error('cancelled'))
          },
          { once: true }
        )
      )
    }
  })
  const controller = new AbortController()
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...Object.fromEntries(server.descriptor.headers.map(({ name, value }) => [name, value]))
  }
  const request = fetch(server.descriptor.url, {
    method: 'POST',
    signal: controller.signal,
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'orca_conversation_evidence', arguments: { action: 'list' } }
    })
  }).catch(() => undefined)
  try {
    await started
    controller.abort()
    await request
    await stopped
  } finally {
    await server.close()
  }
})
