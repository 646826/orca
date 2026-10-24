import { randomUUID } from 'node:crypto'
import { agentSessionProviderHandleKey } from '../../../shared/agent-session-provider-handle'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createStructuredAgentSessionOwnerProbe } from '../../runtime/structured-agent-session-owner-probe'
import { createStructuredClaudeRuntimeAdapter } from '../../runtime/structured-claude-runtime-adapter'
import {
  CLAUDE_STRUCTURED_BASE_OPTIONS,
  claudeSessionIdForOrcaSession
} from '../../claude/claude-structured-launch-resolution'
import { CLAUDE_STRUCTURED_AGENT } from '../../claude/claude-structured-agent-definition'
import { z } from 'zod'
import { expect, vi } from 'vitest'
import { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import { AcpStructuredSessionAdapter } from '../../acp/acp-structured-session-adapter'
import { acpLaunchSpecFor } from '../../acp/acp-launch-specs'
import { acpStructuredAgentDefinition } from '../../acp/acp-structured-agent-definitions'
import { createAcpAgentConnection } from '../../acp/acp-agent-connection'
import type { AcpStructuredSessionAdapterDeps } from '../../acp/acp-structured-session-adapter-deps'
import { StructuredAgentRegistry } from './structured-agent-registry'
import { StructuredAgentSessionAdapterRouter } from './structured-agent-session-adapter-router'
import { CODEX_STRUCTURED_AGENT } from '../../codex/codex-structured-agent-definition'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  hostTestState,
  replaceHostTestState,
  CALLER
} from './structured-agent-session-host-test-harness'
import * as sessionTest from './structured-agent-session-host-test-data'
import { createConversationRoundtripControls } from './structured-conversation-roundtrip-controls.test-fixture'
import { createRuntimeConversationPreparationFactory } from '../../runtime/structured-conversation-preparation-factory'
import { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import { setAgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store-registry'
import { setStructuredAgentSessionHost } from './structured-agent-session-registry'
import {
  call,
  STRUCTURED_CLIENT
} from '../../runtime/rpc/methods/structured-agent-session-rpc.test-fixture'
import { CONVERSATION_METHODS } from '../../runtime/rpc/methods/conversation-methods'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../../runtime/rpc/methods/structured-agent-session'
import { NATIVE_CONVERSATION_RUNTIME_CAPABILITY } from '../../../shared/conversation-runtime-capabilities'
import { structuredAgentSessionMessageSendMutation } from '../../../shared/structured-agent-session-send-mutation'

const NativeInput = z.object({
  kind: z.literal('input'),
  nativeId: z.string(),
  clientId: z.string().optional(),
  requestId: z.union([z.string(), z.number()]).optional(),
  input: z.unknown()
})
export const OPENCODE_ROUNDTRIP_MODELS = {
  codex: 'fixture-model',
  opencode: 'fixture-model',
  claude: 'claude-fake'
} as const
export function opencodeRoundtripFixture(openCodeReply = 'Fixture response.') {
  const state = hostTestState(),
    directory = state.root
  let host: StructuredAgentSessionHost
  const settlements: Promise<void>[] = []
  const codex = new CodexStructuredSessionAdapter({
    resolveLaunch: async ({ identity, spawnToken }) => ({
      command: process.execPath,
      args: [
        resolve('tests/e2e/fixtures/conversation-native-stub.cjs'),
        'codex',
        directory,
        'app-server'
      ],
      cwd: directory,
      codexHome: join(directory, 'codex-home'),
      resumeThreadId: identity.providerHandle?.nativeId ?? null,
      env: { ORCA_AGENT_SESSION_SPAWN_TOKEN: spawnToken },
      model: OPENCODE_ROUNDTRIP_MODELS.codex
    }),
    onDispatchSettledLate: (value) => {
      settlements.push(host.settleLateDispatch(value))
    },
    onHeldSendsChanged: ({ sessionId }) => queueMicrotask(() => host.publishWorkChanged(sessionId)),
    onEvent: (event) => {
      if (event.type === 'ended' && 'cause' in event) {
        settlements.push(host.handleAdapterEvent(event))
      }
    },
    now: () => sessionTest.HOST_TEST_NOW
  })
  const spec = acpLaunchSpecFor('opencode')!
  const resolveLaunch: AcpStructuredSessionAdapterDeps['resolveLaunch'] = async ({
    identity,
    spawnToken
  }) => ({
    spec,
    command: process.execPath,
    args: [
      resolve('tests/e2e/fixtures/conversation-native-stub.cjs'),
      'opencode',
      directory,
      'acp'
    ],
    cwd: directory,
    env: { ORCA_AGENT_SESSION_SPAWN_TOKEN: spawnToken, ORCA_E2E_CONVERSATION_REPLY: openCodeReply },
    envToDelete: [],
    fullAccess: false,
    resume: identity.providerHandle
      ? {
          sessionId: identity.providerHandle.nativeId,
          key: agentSessionProviderHandleKey(identity.providerHandle),
          mayBeUnsaved: () => false,
          unannouncedLosses: () => []
        }
      : null
  })
  const opencode = new AcpStructuredSessionAdapter({
    spec,
    resolveLaunch,
    readLaunch: (identity) => resolveLaunch({ identity, spawnToken: 'read-only' }),
    connect: createAcpAgentConnection,
    dataDirectory: directory,
    onDispatchSettledLate: (value) => {
      settlements.push(host.settleLateDispatch(value))
    },
    onEvent: (event) => {
      settlements.push(host.handleAdapterEvent(event))
    }
  })
  const claudeCli = join(directory, 'claude-conversation-peer.mjs')
  writeFileSync(
    claudeCli,
    `process.argv.splice(2, 0, ${JSON.stringify(join(directory, 'claude-launch.jsonl'))});\nawait import(${JSON.stringify(pathToFileURL(resolve('tests/e2e/fixtures/structured-claude-stub.cjs')).href)});\n`
  )
  const claude = createStructuredClaudeRuntimeAdapter({
    store: state.store,
    resolveWorkspacePath: async () => directory,
    resolveLaunch: async ({ identity, spawnToken }) => {
      const nativeId =
        identity.providerHandle?.nativeId ?? claudeSessionIdForOrcaSession(identity.sessionId)
      return {
        pathToClaudeCodeExecutable: claudeCli,
        contextDeliveryVersion: '2.1.309',
        options: {
          ...CLAUDE_STRUCTURED_BASE_OPTIONS,
          sessionId: nativeId,
          model: OPENCODE_ROUNDTRIP_MODELS.claude,
          permissionMode: 'default'
        },
        cwd: directory,
        claudeConfigDir: join(directory, 'claude-home'),
        providerSessionId: nativeId,
        resumeLeafUuid: null,
        resumesTranscript: Boolean(identity.providerHandle),
        continuesChain: false,
        env: {
          ORCA_E2E_CONVERSATION_STUB_DIRECTORY: directory,
          ORCA_AGENT_SESSION_SPAWN_TOKEN: spawnToken
        }
      }
    },
    onDispatchSettledLate: (value) => {
      settlements.push(host.settleLateDispatch(value))
    },
    onLifecycleEvent: (event) => {
      settlements.push(host.handleAdapterEvent(event))
    }
  })
  const agents = new StructuredAgentRegistry([
    { definition: CODEX_STRUCTURED_AGENT, adapter: codex },
    { definition: CLAUDE_STRUCTURED_AGENT, adapter: claude },
    { definition: acpStructuredAgentDefinition(spec), adapter: opencode }
  ])
  const adapter = new StructuredAgentSessionAdapterRouter(agents, async () => {
    await codex.closeAll()
    await opencode.closeAll()
    await claude.closeAll()
  })
  host = new StructuredAgentSessionHost({
    ...state.host.deps,
    mintSpawnToken: randomUUID,
    probeOwner: createStructuredAgentSessionOwnerProbe('local'),
    adapter,
    agents,
    resolveWorkspacePath: async () => directory,
    conversationPreparationFactory: createRuntimeConversationPreparationFactory(
      state.host.deps.journalDatabase.db,
      directory
    ),
    hasOpenDispatch: () => false
  })
  replaceHostTestState({ host, store: state.store })
  setStructuredAgentSessionHost(host)
  setAgentSessionAttachmentStore(
    new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(directory), {
      hasSession: (id) => state.store.getRecord(id) !== null
    })
  )
  const rpc = async (method: string, params: unknown) => {
    const result = await call(
      method,
      params,
      {
        ...STRUCTURED_CLIENT,
        pairedDeviceId: CALLER.callerKey,
        clientCapabilities: [
          ...STRUCTURED_CLIENT.clientCapabilities,
          NATIVE_CONVERSATION_RUNTIME_CAPABILITY
        ]
      },
      { publishConversationSurfaces: async () => {} },
      [...CONVERSATION_METHODS, ...STRUCTURED_AGENT_SESSION_METHODS]
    )
    if (!result.ok) {
      throw new Error(`${method}: ${JSON.stringify(result)}`)
    }
    return result.result
  }
  const inputs = (agent: 'opencode' | 'codex' | 'claude') => {
    const path = join(directory, `${agent}.jsonl`)
    return existsSync(path)
      ? readFileSync(path, 'utf8')
          .split('\n')
          .filter(Boolean)
          .flatMap((line) => {
            const value = NativeInput.safeParse(JSON.parse(line))
            return value.success ? [value.data] : []
          })
      : []
  }
  const settle = async (sessionId: string, count: number) => {
    await vi.waitFor(
      async () => {
        await Promise.all(settlements)
        await host.flushStreamedEvents(sessionId)
        const journal = host.collaboratorsForTests().sessions.get(sessionId)?.journal
        expect(
          journal?.submissions().filter((row) => row.dispatchState === 'accepted')
        ).toHaveLength(count)
        expect(journal?.runningTurn()).toBeNull()
      },
      { timeout: 10000 }
    )
  }
  const sendRpc = (sessionId: string, text: string, queue = false) =>
    rpc(
      'agentSession.send',
      structuredAgentSessionMessageSendMutation({
        sessionId,
        clientOperationId: sessionTest.hostTestOperationId(),
        expectedRuntimeFence: state.store.getRecord(sessionId)!.lease.runtimeFence,
        body: sessionTest.hostTestMessage(text),
        ...(queue ? { delivery: 'queue-if-active' as const } : {})
      })
    )
  return {
    ...createConversationRoundtripControls(host),
    host,
    store: state.store,
    db: host.deps.journalDatabase.db,
    directory,
    rpc,
    sendRpc,
    inputs,
    opencodeObservations: () =>
      readFileSync(join(directory, 'opencode.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line)),
    codexRequests: () =>
      readFileSync(join(directory, 'codex.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .flatMap((line) => {
          const parsed = z
            .object({
              kind: z.literal('request'),
              frame: z.object({ method: z.string(), params: z.unknown().optional() })
            })
            .safeParse(JSON.parse(line))
          return parsed.success ? [parsed.data.frame] : []
        }),
    diagnostic: (sessionId: string) => ({
      record: state.store.getRecord(sessionId),
      summary: host.readStatusSummary(sessionId),
      child: host.collaboratorsForTests().sessions.get(sessionId)?.child,
      capabilities: adapter.contextDeliveryCapabilities(sessionId),
      logs: state.log.entries.map((entry) => ({
        ...entry,
        fields: { ...entry.fields, error: String(entry.fields.error) }
      }))
    }),
    settle,
    close: async () => {
      setStructuredAgentSessionHost(null)
      setAgentSessionAttachmentStore(null)
      await adapter.closeAll()
      await Promise.all(settlements)
    }
  }
}
