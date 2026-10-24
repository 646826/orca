import { expect, it, vi } from 'vitest'
import { AgentSessionPreDispatchError } from '../native-chat/agent-session-wire/structured-agent-session-operation-settlement'
import { acquired, fakeClaude, USER_MESSAGE } from './claude-structured-session-test-support'

it('does not enqueue a continuation refused at the provider dispatch boundary', async () => {
  const claude = fakeClaude()
  const settled = vi.fn()
  const adapter = await acquired(claude, {}, [], settled)
  const refusal = new AgentSessionPreDispatchError('agent_session_restart_work_superseded')
  try {
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'continuation',
        body: USER_MESSAGE,
        fence: 7,
        beforeDispatch: async () => {
          throw refusal
        }
      })
    ).rejects.toBe(refusal)
    expect(claude.connections[0]?.sent).toEqual([])
    expect(settled).not.toHaveBeenCalled()
  } finally {
    await adapter.closeAll()
  }
})

it('rechecks authority after option preparation before yielding the user message', async () => {
  const claude = fakeClaude({ initModels: [{ value: 'opus' }] })
  const adapter = await acquired(claude, {}, [])
  let checks = 0
  const refusal = new AgentSessionPreDispatchError('conversation-switch-frozen')
  try {
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'later',
        body: USER_MESSAGE,
        executionOptions: { model: 'opus' },
        fence: 7,
        beforeDispatch: async () => {
          if (++checks > 1) {
            throw refusal
          }
        }
      })
    ).rejects.toBe(refusal)
    expect(claude.connections[0]?.calls).toContainEqual({
      subtype: 'set_model',
      params: { model: 'opus' }
    })
    expect(claude.connections[0]?.sent).toEqual([])
  } finally {
    await adapter.closeAll()
  }
})

it('observes the exact SDK user message before it is yielded', async () => {
  const claude = fakeClaude()
  const adapter = await acquired(claude, {}, [])
  const observed: unknown[] = []
  try {
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'observed',
      fence: 7,
      body: USER_MESSAGE,
      beforeContextDispatch: async (value) => {
        observed.push(structuredClone(value))
      }
    })
    expect(observed).toHaveLength(1)
    expect(observed[0]).toEqual({ transport: 'claude', payload: claude.connections[0]?.sent[0] })
  } finally {
    await adapter.closeAll()
  }
})

it('preserves a Stop during final context observation before the user message is written', async () => {
  const claude = fakeClaude()
  const adapter = await acquired(claude, {}, [])
  const stop = new AbortController()
  const reason = new Error('stopped during context observation')
  const observed = vi.fn(async () => {
    stop.abort(reason)
  })
  try {
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'context-stop',
        body: USER_MESSAGE,
        fence: 7,
        signal: stop.signal,
        beforeContextDispatch: observed
      })
    ).rejects.toBe(reason)
    expect(observed).toHaveBeenCalledOnce()
    expect(claude.connections[0]?.sent).toEqual([])
  } finally {
    await adapter.closeAll()
  }
})
