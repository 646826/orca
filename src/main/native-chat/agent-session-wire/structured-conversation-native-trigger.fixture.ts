import { stageConversationTriggerClaims } from '../conversations/conversation-trigger-claim-staging'
import { triggerClaimsFixture } from '../conversations/conversation-trigger-claims.test-fixture'
import { prepareConversationTrigger } from '../conversations/conversation-trigger-claims'
import { appendConversationTransfer } from './structured-conversation-source-queue'
import { finalizeConversationDeliveryReceipt } from '../conversations/conversation-delivery-receipt'
import { hostTestState } from './structured-agent-session-host-test-harness'

/** Real host/journal/receipt path; preparation authority is controlled by this transport fixture. */
export async function nativeTriggerFixture(
  target: Parameters<typeof triggerClaimsFixture>[1],
  begin?: Parameters<typeof triggerClaimsFixture>[2],
  createBody?: Parameters<typeof triggerClaimsFixture>[0],
  sourceOptions?: Record<string, string>
) {
  const f = await triggerClaimsFixture(createBody, target, begin, sourceOptions)
  await stageConversationTriggerClaims(
    f.db,
    {
      ...f.request,
      expectedIntentVersion: f.intent.version,
      stateDirectory: f.host.deps.journalDatabase.stateDirectory
    },
    1,
    new AbortController().signal,
    f.deliveryHost.getJournal
  )
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
  const acquisition = hostTestState().acquire.mock.calls.findLast(
    ([input]) => input.identity.sessionId === f.targetId
  )?.[0]
  if (!acquisition) {
    throw new Error('Missing actual target acquisition')
  }
  const journal = f.host.collaboratorsForTests().sessions.get(f.targetId)!.journal
  const jobs: Promise<unknown>[] = []
  const settle = (event: Parameters<typeof f.host.settleLateDispatch>[0]) => {
    jobs.push(f.host.settleLateDispatch(event))
  }
  const flush = async () => {
    await Promise.all(jobs)
    await f.host.flushStreamedEvents(f.targetId)
  }
  const receipt = () =>
    finalizeConversationDeliveryReceipt(
      f.db,
      f.plan.planId,
      f.deliveryHost,
      new AbortController().signal
    )
  return {
    ...f,
    acquisition,
    journal,
    settle,
    flush,
    receipt,
    async append() {
      const record = f.store.getRecord(f.targetId)!
      await appendConversationTransfer({
        db: f.db,
        source: f.source,
        target: journal,
        binding: prepared.binding,
        authority: prepared.authority,
        body: prepared.body,
        options: prepared.options,
        fence: record.lease.runtimeFence,
        now: 1,
        isCurrent: (entry) => f.deliveryHost.getJournal(entry.queuedMessages.sessionId) === entry
      })
    },
    async activate() {
      await flush()
      const evidence = await receipt()
      if (!evidence) {
        throw new Error('No genuine delivery receipt')
      }
      const current = f.store.conversations.intent(f.intent.operationKey)!
      const ready = await f.store.conversations.progress({
        operationKey: current.operationKey,
        expectedVersion: current.version,
        phase: 'delivering',
        sourceBoundaries: evidence.sourceBoundaries,
        candidateBoundary: evidence.candidateBoundary,
        manifestId: f.manifest.manifestId,
        deliveryReceiptId: evidence.deliveryReceiptId
      })
      const conversation = f.store.conversations.read(f.intent.conversationId)!
      return f.store.conversations.activate({
        operationKey: ready.operationKey,
        expectedVersion: ready.version,
        expectedRevision: conversation.revision,
        expectedContextGeneration: conversation.contextGeneration,
        expectedActivationFence: conversation.activationFence,
        expectedNativeBindingGeneration: ready.nativeBindingGeneration,
        deliveryReceiptId: evidence.deliveryReceiptId,
        sourceBoundaries: evidence.sourceBoundaries
      })
    }
  }
}
