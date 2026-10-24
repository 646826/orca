import { assertConversationPreparationTarget } from '../conversations/conversation-preparation-target'
import {
  readWorkspaceWatchObservation,
  recordWorkspaceWatchEvents
} from '../../runtime/workspace-watch-observation'
import { createConversationContinuationDriver } from './structured-conversation-continuation-driver'
import { hostTestMessage } from './structured-agent-session-host-test-data'
import { expect, it, vi } from 'vitest'
import { triggerClaimsFixture } from '../conversations/conversation-trigger-claims.test-fixture'
import { prepareConversationTrigger } from '../conversations/conversation-trigger-claims'
import { appendConversationTransfer } from './structured-conversation-source-queue'
import { finalizeConversationDeliveryReceipt } from '../conversations/conversation-delivery-receipt'
import { hostTestState, CALLER, envelope } from './structured-agent-session-host-test-harness'
import { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import {
  fakeCodexAppServer,
  echoUserMessage
} from '../../codex/codex-structured-dispatch-test-support'
import { acquireReadyCodexForTest } from '../../codex/codex-structured-session-adapter-fixture'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'

it.each(['accepted', 'unknown', 'workspace-change'] as const)(
  'dispatches one reserved native trigger and reconciles %s',
  async (outcome) => {
    const f = await triggerClaimsFixture()
    const workspaceRoot = { rootPath: '/fixture-workspace' }
    const capturedWorkspace = readWorkspaceWatchObservation(workspaceRoot, 'fixture-host-folder')
    if (outcome === 'workspace-change') {
      const expected = {
        target: f.manifest.target,
        budget: f.manifest.budget,
        nativeIdentityDigest: f.plan.nativeIdentityDigest,
        runtimeFence: f.plan.runtimeFence,
        optionsDigest: 'fixture-options',
        freshNative: true,
        workspaceObservation: capturedWorkspace
      }
      const evidence = f.deliveryHost.readPreparationEvidence
      const validate = (allowDispatchedWorkspace: boolean) => {
        assertConversationPreparationTarget(
          f.db,
          f.manifest,
          expected,
          {
            ...expected,
            workspaceObservation: readWorkspaceWatchObservation(
              workspaceRoot,
              'fixture-host-folder'
            )
          },
          1,
          allowDispatchedWorkspace,
          f.intent.operationKey
        )
        return evidence(f.db, f.manifest)
      }
      f.deliveryHost.readPreparationEvidence = () => validate(true)
      f.deliveryHost.readPreDispatchPreparationEvidence = () => validate(false)
    }
    const prepared = await prepareConversationTrigger(
      f.db,
      f.request,
      f.claimsHost,
      1,
      new AbortController().signal
    )
    await f.store.conversations.progress({
      operationKey: f.intent.operationKey,
      expectedVersion: f.intent.version,
      phase: 'delivering',
      sourceBoundaries: f.intent.sourceBoundaries,
      manifestId: f.manifest.manifestId,
      deliveryReceiptId: null
    })
    f.host.deps.conversationTransferAuthority = prepared.authority
    f.host.deps.conversationDeliveryHost = f.deliveryHost
    const laterBody = hostTestMessage('second queued intent')
    const later = await f.host.send(CALLER, {
      envelope: envelope('agentSession.send', { body: laterBody, delivery: 'queue-if-active' }),
      body: laterBody,
      delivery: 'queue-if-active',
      userSend: true
    })
    expect(later.ok).toBe(true)
    expect(
      f.source.queuedMessages.list().filter((draft) => draft.state === 'waiting')
    ).toHaveLength(2)
    const target = f.store.getRecord(f.targetId)!
    const native = agentSessionProviderHandleChainHead(target.providerHandleChain)!.handle
    if (native.agent !== 'codex') {
      throw new Error('fixture native kind')
    }
    const codex = fakeCodexAppServer({
      'thread/start': () => ({ thread: { id: native.nativeId } }),
      'thread/resume': () => ({ thread: { id: native.nativeId } }),
      'turn/start': () => {
        if (outcome === 'unknown') {
          throw new Error('transport lost after write')
        }
        if (outcome === 'workspace-change') {
          recordWorkspaceWatchEvents(workspaceRoot, false)
        }
        return { turn: { id: 'trigger-turn' } }
      }
    })
    const settlementJobs: Promise<void>[] = []
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: '/work/repo',
        codexHome: null,
        resumeThreadId: null
      }),
      openConnection: codex.openConnection,
      readProcessStartTime: async () => 1700000000000,
      now: () => 1700000000500,
      onDispatchSettledLate: (value) => {
        settlementJobs.push(f.host.settleLateDispatch(value))
      }
    })
    const acquired = hostTestState().acquire.mock.calls.findLast(
      ([input]) => input.identity.sessionId === f.targetId
    )?.[0]
    if (!acquired) {
      throw new Error('missing target acquire')
    }
    await acquireReadyCodexForTest(adapter, { ...acquired, onSpawned: undefined })
    f.dispatch.mockImplementation((input) => adapter.dispatch(input))
    try {
      const journal = f.host.collaboratorsForTests().sessions.get(f.targetId)!.journal
      await appendConversationTransfer({
        db: f.db,
        source: f.source,
        target: journal,
        binding: prepared.binding,
        authority: prepared.authority,
        body: prepared.body,
        options: prepared.options,
        fence: target.lease.runtimeFence,
        now: 1,
        isCurrent: (entry) => f.deliveryHost.getJournal(entry.queuedMessages.sessionId) === entry
      })
      await vi.waitFor(() =>
        expect(
          codex.connections[0]!.calls.filter((x) => x.method === 'turn/start'),
          JSON.stringify({
            submission: journal.submission(prepared.binding.targetSubmissionId),
            calls: f.dispatch.mock.calls.length
          })
        ).toHaveLength(1)
      )
      if (outcome === 'unknown') {
        await vi.waitFor(() =>
          expect(journal.submission(prepared.binding.targetSubmissionId)?.dispatchState).toBe(
            'unknown'
          )
        )
        expect(
          await finalizeConversationDeliveryReceipt(
            f.db,
            f.plan.planId,
            f.deliveryHost,
            new AbortController().signal
          )
        ).toBeNull()
        await f.host.flushStreamedEvents(f.targetId)
        expect(codex.connections[0]!.calls.filter((x) => x.method === 'turn/start')).toHaveLength(1)
        expect(
          f.source.queuedMessages.list().filter((draft) => draft.state === 'waiting')
        ).toHaveLength(1)
        return
      }
      const connection = codex.connections[0]!
      connection.handlers.onNotification?.('turn/started', {
        threadId: native.nativeId,
        turn: { id: 'trigger-turn' }
      })
      echoUserMessage(connection, {
        threadId: native.nativeId,
        turnId: 'trigger-turn',
        itemId: 'trigger-item',
        clientId: prepared.binding.targetSubmissionId
      })
      await vi.waitFor(() => expect(settlementJobs.length).toBeGreaterThan(0))
      await Promise.all(settlementJobs)
      await f.host.flushStreamedEvents(f.targetId)
      expect(
        f.source.queuedMessages.list().filter((draft) => draft.state === 'waiting')
      ).toHaveLength(1)
      expect(journal.receiptFor(prepared.binding.targetSubmissionId)).toMatchObject({
        originCorrelation: 'exact'
      })
      expect(
        f.db
          .prepare(
            'SELECT sequence,atom_path,keys_json FROM conversation_origin_rows WHERE session_id=? AND origin_json IS NULL'
          )
          .all(f.targetId)
      ).toEqual([])
      const delivery = await finalizeConversationDeliveryReceipt(
        f.db,
        f.plan.planId,
        f.deliveryHost,
        new AbortController().signal
      )
      if (!delivery) {
        throw new Error('missing native delivery receipt')
      }
      const current = f.store.conversations.intent(f.intent.operationKey)!
      const ready = await f.store.conversations.progress({
        operationKey: current.operationKey,
        expectedVersion: current.version,
        phase: 'delivering',
        sourceBoundaries: delivery.sourceBoundaries,
        candidateBoundary: delivery.candidateBoundary,
        manifestId: f.manifest.manifestId,
        deliveryReceiptId: delivery.deliveryReceiptId
      })
      const conversation = f.store.conversations.read(f.intent.conversationId)!
      await f.store.conversations.activate({
        operationKey: ready.operationKey,
        expectedVersion: ready.version,
        expectedRevision: conversation.revision,
        expectedContextGeneration: conversation.contextGeneration,
        expectedActivationFence: conversation.activationFence,
        expectedNativeBindingGeneration: ready.nativeBindingGeneration,
        deliveryReceiptId: delivery.deliveryReceiptId,
        sourceBoundaries: delivery.sourceBoundaries
      })
      expect(f.store.conversations.route(f.targetId).role).toBe('active')
      if (outcome === 'workspace-change') {
        expect(() => f.deliveryHost.readPreDispatchPreparationEvidence?.(f.db, f.manifest)).toThrow(
          'Preparation target changed'
        )
        expect(codex.connections[0]!.calls.filter((x) => x.method === 'turn/start')).toHaveLength(1)
      }
      connection.handlers.onNotification?.('turn/completed', {
        threadId: native.nativeId,
        turn: { id: 'trigger-turn', status: 'completed' }
      })
      await f.host.flushStreamedEvents(f.targetId)
      const reportContinuationFailure = vi.fn()
      const continuationPorts = {
        db: f.db,
        stateDirectory: f.claimsHost.stateDirectory,
        deliveryHost: f.deliveryHost,
        publishSourceQueue: () => {},
        now: () => 2,
        reportContinuationFailure
      }
      const closed = new AbortController()
      const stoppedDriver = createConversationContinuationDriver(continuationPorts, closed.signal)
      const pendingDrain = stoppedDriver.continueQueued(ready.operationKey)
      closed.abort()
      await pendingDrain
      expect(
        f.source.queuedMessages.list().filter((draft) => draft.state === 'waiting')
      ).toHaveLength(1)
      const driver = createConversationContinuationDriver(
        continuationPorts,
        new AbortController().signal
      )
      driver.notify(f.targetId)
      await Promise.all([
        driver.continueQueued(ready.operationKey),
        driver.continueQueued(ready.operationKey)
      ])
      expect(reportContinuationFailure).not.toHaveBeenCalled()
      await vi.waitFor(() =>
        expect(connection.calls.filter((x) => x.method === 'turn/start')).toHaveLength(2)
      )
      expect(f.dispatch.mock.calls[1]?.[0].body).toEqual(laterBody)
      expect(
        f.source.queuedMessages.list().filter((draft) => draft.state === 'waiting')
      ).toHaveLength(0)
      expect(codex.connections[0]!.calls.filter((x) => x.method === 'turn/start')).toHaveLength(2)
    } finally {
      await adapter.closeAll()
    }
  }
)
