import { readConversationTransferNoWrite } from '../conversations/conversation-transfer-no-write'
import { ConversationAuthorityRevisionChangedError } from '../conversations/conversation-context-authority-revision'
import {
  readConversationSendableDraft,
  appendConversationTransfer
} from './structured-conversation-source-queue'
import { createConversationContinuationDriver } from './structured-conversation-continuation-driver'
import { createConversationCommitNotifier } from './structured-conversation-commit-notifier'
import { conversationContextDigest } from '../conversations/conversation-context-consent'
import type { ConversationSwitchIntent } from '../../../shared/conversation-record'
import type { ConversationSwitchDelivery } from '../conversations/conversation-switch-contracts'
import type { StructuredConversationSwitchRuntime } from './structured-conversation-switch-host'
import { prepareConversationDeliveryPlan } from '../conversations/conversation-delivery-plan'
import { finalizeConversationDeliveryReceipt } from '../conversations/conversation-delivery-receipt'
import { refreshVerifiedConversationManifestIndex } from '../conversations/conversation-delivery-reauthorization'
import {
  createConversationTriggerAuthority,
  prepareConversationTrigger
} from '../conversations/conversation-trigger-claims'
import { readConversationTrigger } from '../conversations/conversation-trigger-reservation'
import { stageConversationTriggerClaims } from '../conversations/conversation-trigger-claim-staging'
import { readConversation, readSegments } from '../conversations/conversation-read-model'
import { reconcileConversationOrigins } from '../conversations/conversation-origin-reconciliation'
import type {
  ConversationPreparationTrigger,
  StructuredConversationSwitchRuntimePorts
} from './structured-conversation-switch-runtime-contracts'
export function createStructuredConversationSwitchRuntime(
  ports: StructuredConversationSwitchRuntimePorts
) {
  const { db, deliveryHost } = ports
  const claimsHost = {
    stateDirectory: ports.stateDirectory,
    getRecord: deliveryHost.getRecord.bind(deliveryHost),
    getJournal: deliveryHost.getJournal.bind(deliveryHost),
    readPreparationEvidence: deliveryHost.readPreparationEvidence
  }
  const transferAuthority = createConversationTriggerAuthority(claimsHost)
  const lifetime = new AbortController()
  const commits = createConversationCommitNotifier(lifetime.signal)
  const continuations = createConversationContinuationDriver(ports, lifetime.signal)
  const observationChanged = (error: unknown, sessionId: string, version: number) =>
    error instanceof ConversationAuthorityRevisionChangedError &&
    commits.revision(sessionId) !== version
  const stage = async (
    intent: ConversationSwitchIntent,
    signal: AbortSignal
  ): Promise<ConversationPreparationTrigger | null> => {
    signal.throwIfAborted()
    lifetime.signal.throwIfAborted()
    const conversation = readConversation(db, intent.conversationId)
    const active =
      conversation &&
      readSegments(db, intent.conversationId).find(
        (s) => s.segmentId === conversation.activeSegmentId
      )
    if (!active || active.sessionId === intent.targetSessionId) {
      throw new Error('Trigger source is unavailable')
    }
    const draft = readConversationSendableDraft(
      db,
      { ...intent, sessionId: active.sessionId },
      deliveryHost.getJournal.bind(deliveryHost)
    )
    if (!draft) {
      return null
    }
    if (draft.body.command || draft.body.role !== 'user') {
      throw new Error('Trigger is not an ordinary user turn')
    }
    const transferId = `conversation-trigger:${intent.operationKey}:${draft.messageId}`
    const claims = await stageConversationTriggerClaims(
      db,
      {
        kind: 'trigger',
        transferId,
        operationKey: intent.operationKey,
        expectedIntentVersion: intent.version,
        queueSessionId: active.sessionId,
        messageId: draft.messageId,
        stateDirectory: ports.stateDirectory
      },
      ports.now(),
      signal,
      deliveryHost.getJournal.bind(deliveryHost)
    )
    const target = deliveryHost.getRecord(intent.targetSessionId)
    if (!target) {
      throw new Error('Trigger target is unavailable')
    }
    return {
      targetOptionsDigest: conversationContextDigest(target.options ?? null),
      queueSessionId: active.sessionId,
      messageId: draft.messageId,
      transferId,
      sourceFingerprint: claims.sourceFingerprint,
      attachmentClaimsDigest: claims.attachmentClaimsDigest
    }
  }
  const accepted = async (
    intent: ConversationSwitchIntent,
    signal: AbortSignal
  ): Promise<ConversationSwitchDelivery> => {
    const reservation = readConversationTrigger(db, intent.operationKey)
    if (
      !reservation ||
      !['appended', 'uncertain', 'accepted', 'proven-no-effect'].includes(reservation.state)
    ) {
      return { kind: 'unknown' }
    }
    await ports.flushEvents(intent.targetSessionId)
    await reconcileConversationOrigins(db, intent.targetSessionId, signal)
    let receipt
    try {
      receipt = await finalizeConversationDeliveryReceipt(
        db,
        reservation.binding.deliveryPlanId,
        deliveryHost,
        signal
      )
    } catch (error) {
      signal.throwIfAborted()
      if (readConversationTransferNoWrite(db, reservation.binding.transferId)) {
        return { kind: 'proven-no-effect' }
      }
      throw error
    }
    return receipt
      ? {
          kind: 'accepted',
          receiptId: receipt.deliveryReceiptId,
          candidateBoundary: receipt.candidateBoundary
        }
      : readConversationTransferNoWrite(db, reservation.binding.transferId)
        ? { kind: 'proven-no-effect' }
        : { kind: 'unknown' }
  }
  const runtime: StructuredConversationSwitchRuntime = {
    continueQueued: continuations.continueQueued,
    async prepare(intent, previousManifestId, signal) {
      signal = AbortSignal.any([signal, lifetime.signal])
      signal.throwIfAborted()
      await ports.ensureCandidate(intent, signal)
      const trigger = previousManifestId ? null : await stage(intent, signal)
      const result = await ports.preparation.prepare(intent, previousManifestId, signal, trigger)
      return result.kind === 'prepared' && result.plan.delivery === 'passive'
        ? { kind: 'blocked', reasons: ['passive-delivery-unverified'] }
        : result
    },
    readPlan: ports.preparation.readPlan.bind(ports.preparation),
    async reserveTrigger(intent, plan, signal) {
      signal = AbortSignal.any([signal, lifetime.signal])
      signal.throwIfAborted()
      const existing = readConversationTrigger(db, intent.operationKey)
      if (existing) {
        if (existing.binding.manifestId !== plan.manifestId || existing.state !== 'reserved') {
          throw new Error('Trigger cannot be replayed or rebound')
        }
        return { reservationId: existing.binding.transferId }
      }
      const trigger = await stage(intent, signal)
      if (!trigger) {
        return null
      }
      ports.preparation.verifyTrigger(plan.manifestId, trigger)
      const delivery = await prepareConversationDeliveryPlan(
        db,
        {
          operationKey: intent.operationKey,
          manifestId: plan.manifestId,
          expectedIntentVersion: intent.version
        },
        deliveryHost,
        signal
      )
      const prepared = await prepareConversationTrigger(
        db,
        {
          ...trigger,
          kind: 'trigger',
          operationKey: intent.operationKey,
          deliveryPlanId: delivery.planId,
          targetSubmissionId: `${trigger.transferId}:submission`
        },
        claimsHost,
        ports.now(),
        signal
      )
      return { reservationId: prepared.binding.transferId }
    },
    async deliver(intent, plan, reservationId, signal) {
      signal = AbortSignal.any([signal, lifetime.signal])
      signal.throwIfAborted()
      if (plan.delivery !== 'first-turn' || !reservationId) {
        throw new Error('Passive delivery is unverified')
      }
      const reservation = readConversationTrigger(db, intent.operationKey)
      if (
        !reservation ||
        reservation.state !== 'reserved' ||
        reservation.binding.transferId !== reservationId ||
        reservation.binding.manifestId !== plan.manifestId
      ) {
        return { kind: 'unknown' }
      }
      const binding = reservation.binding
      await refreshVerifiedConversationManifestIndex(
        db,
        plan.manifestId,
        deliveryHost.readPreparationEvidence,
        signal
      )
      const prepared = await prepareConversationTrigger(
        db,
        binding,
        claimsHost,
        ports.now(),
        signal
      )
      const journal = deliveryHost.getJournal(intent.targetSessionId)
      const record = deliveryHost.getRecord(intent.targetSessionId)
      if (!journal || !record) {
        throw new Error('Candidate is unavailable')
      }
      const source = deliveryHost.getJournal(binding.queueSessionId)
      if (!source) {
        throw new Error('Trigger source is unavailable')
      }
      await appendConversationTransfer({
        db,
        source,
        target: journal,
        binding,
        authority: transferAuthority,
        body: prepared.body,
        options: prepared.options,
        fence: record.lease.runtimeFence,
        now: ports.now(),
        signal,
        isCurrent: (entry) => deliveryHost.getJournal(entry.queuedMessages.sessionId) === entry
      })
      ports.publishSourceQueue(binding.queueSessionId)
      for (;;) {
        signal.throwIfAborted()
        lifetime.signal.throwIfAborted()
        const version = commits.revision(intent.targetSessionId)
        let result: ConversationSwitchDelivery
        try {
          result = await accepted(intent, signal)
        } catch (error) {
          if (observationChanged(error, intent.targetSessionId, version)) {
            continue
          }
          throw error
        }
        if (result.kind === 'accepted' || result.kind === 'proven-no-effect') {
          return result
        }
        if (commits.revision(intent.targetSessionId) !== version) {
          continue
        }
        const submission = journal.submission(binding.targetSubmissionId)
        if (!submission || ['unknown', 'rejected', 'accepted'].includes(submission.dispatchState)) {
          return { kind: 'unknown' }
        }
        signal.throwIfAborted()
        await ports.wakeDelivery(intent.targetSessionId, signal)
        await commits.waitForChange(intent.targetSessionId, version, signal)
      }
    },
    async reconcile(intent, _plan, signal) {
      signal = AbortSignal.any([signal, lifetime.signal])
      signal.throwIfAborted()
      const version = commits.revision(intent.targetSessionId)
      try {
        return await accepted(intent, signal)
      } catch (error) {
        signal.throwIfAborted()
        if (observationChanged(error, intent.targetSessionId, version)) {
          return { kind: 'unknown' }
        }
        throw error
      }
    }
  }
  return {
    runtime,
    transferAuthority,
    notifyJournalCommitted: (sessionId: string) => {
      commits.notifyJournalCommitted(sessionId)
      continuations.notify(sessionId)
    },
    close: () => {
      lifetime.abort(new Error('Conversation runtime closed'))
      commits.clear()
    }
  }
}
