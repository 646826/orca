import { expect, it } from 'vitest'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { conversationPreparationModel } from '../runtime/structured-conversation-preparation-factory'
import {
  adapterAtPublishFor,
  claudeFrame,
  fakeClaude,
  identityFor,
  recordingJournalSink,
  USER_MESSAGE
} from './claude-structured-session-test-support'

const MODEL = 'claude-sonnet-5'
async function fixture(observed = true, execution: { effort?: string; fastMode?: boolean } = {}) {
  const peer = fakeClaude({
    initProof: 'none',
    settings: observed
      ? {
          applied: { model: MODEL, ...(execution.effort ? { effort: execution.effort } : {}) },
          effective: execution.fastMode !== undefined ? { fastMode: execution.fastMode } : {},
          sources: {}
        }
      : {}
  })
  const ownedAdapter = adapterAtPublishFor(peer, {
    contextDeliveryVersion: '2.1.309'
  })
  const adapter: StructuredAgentSessionAdapter = ownedAdapter
  const acquired = await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'projection-spawn',
    events: recordingJournalSink(),
    options: { model: MODEL }
  })
  return {
    adapter,
    peer,
    open: async () => {
      await adapter.open({
        sessionId: 'session-1',
        fence: 7,
        acquisitionGeneration: acquired.acquisitionGeneration,
        signal: new AbortController().signal
      })
      await adapter.readOptions?.({ sessionId: 'session-1', fence: 7 })
    },
    projected: (model = MODEL) => adapter.projectOptions?.('session-1', { model }),
    close: () => ownedAdapter.closeAll()
  }
}

it('projects initialized provider-observed execution options without issuing a native prompt', async () => {
  const f = await fixture()
  try {
    await f.open()
    expect(f.projected()?.options.model).toBe(MODEL)
    expect(conversationPreparationModel(MODEL, f.projected()?.options)).toBe(MODEL)
    expect(f.peer.connections[0]!.sent).toHaveLength(0)
  } finally {
    await f.close()
  }
})
it('projects applied effort and observed Fast exactly as ordinary dispatch records them', async () => {
  const f = await fixture(true, { effort: 'high', fastMode: true })
  try {
    await f.open()
    claudeFrame(f.peer.connections[0]!, {
      type: 'system',
      subtype: 'status',
      fast_mode_state: 'on'
    })
    const projected = f.projected()?.options
    expect(projected).toEqual({ model: MODEL, effort: 'high', fastMode: 'true' })
    expect(f.peer.connections[0]!.sent).toHaveLength(0)
    expect(
      await f.adapter.dispatch({
        sessionId: 'session-1',
        fence: 7,
        clientMessageId: 'observed-options-turn',
        body: USER_MESSAGE
      })
    ).toEqual({ state: 'admitted', ranOptions: projected })
    expect(f.peer.connections[0]!.sent).toHaveLength(1)
  } finally {
    await f.close()
  }
})
it('does not promote unknown requested choices or default aliases into observed model authority', async () => {
  const f = await fixture()
  try {
    await f.open()
    for (const requested of ['unknown-model', 'default', 'sonnet']) {
      expect(f.projected(requested)?.options.model).toBe(MODEL)
      expect(conversationPreparationModel(requested, f.projected(requested)?.options)).toBeNull()
    }
  } finally {
    await f.close()
  }
})
it('refuses absent native model observations even when launch selected a model', async () => {
  const f = await fixture(false)
  try {
    await f.open()
    expect(f.projected()).toBeDefined()
    expect(f.projected()?.options.model).toBeUndefined()
    expect(conversationPreparationModel(MODEL, f.projected()?.options)).toBeNull()
  } finally {
    await f.close()
  }
})
it('retires stale model observations until the changed provider reports the new model', async () => {
  const f = await fixture()
  try {
    await f.open()
    await f.adapter.setOption({
      sessionId: 'session-1',
      fence: 7,
      key: 'model',
      value: 'claude-other'
    })
    expect(f.projected('claude-other')?.options.model).toBeUndefined()
    claudeFrame(f.peer.connections[0]!, {
      type: 'system',
      subtype: 'init',
      uuid: 'new-model-init',
      model: 'claude-other'
    })
    expect(f.projected('claude-other')?.options.model).toBe('claude-other')
    expect(conversationPreparationModel(MODEL, f.projected()?.options)).toBeNull()
  } finally {
    await f.close()
  }
})
it('keeps unsupported option rejection and does not project a provider-retired model', async () => {
  const f = await fixture()
  try {
    await f.open()
    await expect(
      f.adapter.setOption({ sessionId: 'session-1', fence: 7, key: 'unsupported-key', value: 'x' })
    ).rejects.toThrow('no session option')
    expect(f.projected()?.options.model).toBe(MODEL)
    claudeFrame(f.peer.connections[0]!, {
      type: 'assistant',
      uuid: 'retired-model-reply',
      parent_tool_use_id: null,
      error: 'model_not_found',
      is_api_error_message: true,
      message: { model: '<synthetic>', role: 'assistant', content: [] }
    })
    expect(f.adapter.readOptionRestoreFailures?.('session-1')).toEqual(['model'])
    expect(f.projected()?.options.model).not.toBe(MODEL)
  } finally {
    await f.close()
  }
})
it('never projects a missing, unpublished, or closed native session', async () => {
  const f = await fixture()
  try {
    expect(f.adapter.projectOptions?.('missing', { model: MODEL })).toBeUndefined()
    expect(f.projected()).toBeUndefined()
    await f.open()
    expect(f.projected()?.options.model).toBe(MODEL)
    await f.close()
    expect(f.projected()).toBeUndefined()
  } finally {
    await f.close()
  }
})
