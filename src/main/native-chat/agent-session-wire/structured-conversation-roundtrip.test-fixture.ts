import { expect, vi } from 'vitest'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { hostTestState, replaceHostTestState } from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD
} from './structured-agent-session-host-test-data'
import { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import { fakeCodex } from '../../codex/codex-structured-session-adapter-fixture'
import { fetchCodexModelCatalogListing } from '../../codex/codex-structured-model-catalog'
import { CODEX_STRUCTURED_AGENT } from '../../codex/codex-structured-agent-definition'
import { AgentModelCatalogStore } from '../agent-model-catalog/agent-model-catalog-store'
import { agentModelCatalogSessionAccess } from '../agent-model-catalog/agent-model-catalog-fingerprint'
import { createRuntimeConversationPreparationFactory } from '../../runtime/structured-conversation-preparation-factory'
import { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import { setAgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store-registry'

import { createConversationRoundtripControls } from './structured-conversation-roundtrip-controls.test-fixture'

export async function createCodexConversationRoundtripFixture(
  reported: { effort?: string; catalog?: boolean } = {}
) {
  const state = hostTestState()
  expect(state.host.collaboratorsForTests().sessions.size).toBe(0)
  await state.host.flushAllStreamedEvents()
  const targetId = 'journey-target'
  const targetThread = '019fd532-7c11-7a90-b6de-4e1a2c3d5f61'
  let turn = 0,
    thread = 0
  let nextTurn = Promise.withResolvers<void>()
  const codex = fakeCodex({
    initialize: () => ({ userAgent: 'codex_cli_rs/0.159.0-alpha.3' }),
    'thread/start': () => ({
      thread: { id: ++thread === 1 ? HOST_TEST_THREAD : targetThread },
      model: 'gpt-live',
      ...(reported.effort ? { reasoningEffort: reported.effort } : {})
    }),
    'turn/start': () => {
      const result = { turn: { id: `journey-turn-${++turn}` } }
      nextTurn.resolve()
      nextTurn = Promise.withResolvers<void>()
      return result
    }
  })
  const settlements: Promise<void>[] = []
  const catalog = new AgentModelCatalogStore()
  const catalogAccess = agentModelCatalogSessionAccess(catalog, CODEX_STRUCTURED_AGENT, state.root)!
  let host: StructuredAgentSessionHost
  const adapter = new CodexStructuredSessionAdapter({
    resolveLaunch: async ({ identity }) => ({
      command: 'codex',
      args: ['app-server'],
      cwd: state.root,
      codexHome: reported.catalog ? state.root : null,
      resumeThreadId: identity.providerHandle?.nativeId ?? null
    }),
    openConnection: codex.openConnection,
    modelCatalog: catalog,
    readProcessStartTime: async () => HOST_TEST_NOW,
    now: () => HOST_TEST_NOW,
    onDispatchSettledLate: (value) => {
      settlements.push(host.settleLateDispatch(value))
    }
  })
  host = new StructuredAgentSessionHost({
    ...state.host.deps,
    adapter,
    conversationPreparationFactory: createRuntimeConversationPreparationFactory(
      state.host.deps.journalDatabase.db,
      state.root
    ),
    probeOwner: async (record) => {
      const connection =
        record.sessionId === HOST_TEST_SESSION
          ? codex.connections[0]
          : record.sessionId === targetId
            ? codex.connections[1]
            : undefined
      return connection &&
        !connection.closed &&
        record.lease.ownerProcess?.pid === connection.pid &&
        record.lease.ownerProcess?.processStartTimeMs === HOST_TEST_NOW
        ? { outcome: 'identity-matched', matchedOn: ['process-start-time'] }
        : { outcome: 'indeterminate', reason: 'Scripted native owner is not live' }
    },
    hasOpenDispatch: () => false
  })
  replaceHostTestState({ host, store: state.store })
  setAgentSessionAttachmentStore(
    new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(state.root), {
      hasSession: (id) => state.store.getRecord(id) !== null
    })
  )
  const db = host.deps.journalDatabase.db
  const signal = new AbortController().signal
  let consumed = 0
  const consumedCalls = new Set<unknown>()
  const acceptNative = async (sessionId: string, response: string | readonly string[]) => {
    if (consumed >= turn) {
      await nextTurn.promise
    }
    const calls = codex.connections.flatMap((connection) =>
      connection.calls
        .filter((call) => call.method === 'turn/start')
        .map((call) => ({ connection, call }))
    )
    const { connection, call } = calls.find(({ call }) => !consumedCalls.has(call))!
    consumedCalls.add(call)
    consumed++
    const threadId = call.params?.threadId,
      clientId = call.params?.clientUserMessageId
    if (typeof threadId !== 'string' || typeof clientId !== 'string') {
      throw new Error('native input identity missing')
    }
    const turnId = `journey-turn-${consumed}`
    connection.handlers.onNotification?.('turn/started', { threadId, turn: { id: turnId } })
    connection.handlers.onNotification?.('item/started', {
      threadId,
      turn: { id: turnId },
      item: { type: 'userMessage', id: `user-${consumed}`, clientId, content: call.params?.input }
    })
    await vi.waitFor(async () => {
      await Promise.all(settlements)
      expect(
        host.collaboratorsForTests().sessions.get(sessionId)?.journal.receiptFor(clientId)
          ?.originCorrelation
      ).toBe('exact')
    })
    const responses = typeof response === 'string' ? [response] : response
    for (const [index, text] of responses.entries()) {
      connection.handlers.onNotification?.('item/completed', {
        threadId,
        turn: { id: turnId },
        item: { type: 'agentMessage', id: `answer-${consumed}-${index}`, text }
      })
    }
    connection.handlers.onNotification?.('turn/completed', {
      threadId,
      turn: { id: turnId, status: 'completed' }
    })
    await host.flushStreamedEvents(sessionId)
    return call.params
  }
  return {
    state,
    host,
    db,
    signal,
    targetId,
    codex,
    acceptNative,
    discoverCatalog: async () => {
      const discover = async () => ({
        ...(await fetchCodexModelCatalogListing({ connection: codex.connections[0]! })),
        origin: 'probe' as const
      })
      return catalog.refresh(catalogAccess.fingerprint, 'codex', discover, discover)
    },
    ...createConversationRoundtripControls(host),
    close: async () => {
      setAgentSessionAttachmentStore(null)
      await adapter.closeAll()
    }
  }
}
