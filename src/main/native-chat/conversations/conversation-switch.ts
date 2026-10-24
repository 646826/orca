import type { ConversationSwitchIntent } from '../../../shared/conversation-record'
import { ConversationRefusal } from './conversation-read-model'
import {
  conversationSwitchNeedsReconciliation,
  requireConversationSwitchReconciliation
} from './conversation-recovery'
import type {
  ConversationSwitchDelivery,
  ConversationSwitchPlan,
  ConversationSwitchPorts,
  ConversationSwitchResult
} from './conversation-switch-contracts'

export function createConversationSwitchCoordinator(ports: ConversationSwitchPorts) {
  const { store } = ports
  const sourceMatches = (intent: ConversationSwitchIntent) =>
    JSON.stringify(ports.readSources(intent)) === JSON.stringify(intent.sourceBoundaries)

  const progress = (
    intent: ConversationSwitchIntent,
    phase: 'prepared' | 'delivering',
    plan: ConversationSwitchPlan,
    accepted?: Extract<ConversationSwitchDelivery, { kind: 'accepted' }>
  ) =>
    store.progress({
      operationKey: intent.operationKey,
      expectedVersion: intent.version,
      phase,
      sourceBoundaries: plan.sourceBoundaries,
      candidateBoundary: accepted?.candidateBoundary,
      manifestId: plan.manifestId,
      deliveryReceiptId: accepted?.receiptId ?? null
    })

  const activate = async (
    intent: ConversationSwitchIntent,
    plan: ConversationSwitchPlan,
    accepted: Extract<ConversationSwitchDelivery, { kind: 'accepted' }>
  ): Promise<ConversationSwitchResult> => {
    if (!sourceMatches(intent) || !ports.readPlan(plan.manifestId)) {
      return requireConversationSwitchReconciliation(store, intent)
    }
    let current = intent
    try {
      if (current.phase === 'reconciliation-required') {
        current = await progress(current, 'prepared', plan)
      }
      current = await progress(current, 'delivering', plan, accepted)
      const conversation = store.read(current.conversationId)
      if (!conversation) {
        throw new ConversationRefusal('missing-record')
      }
      const activation = await store.activate({
        operationKey: current.operationKey,
        expectedVersion: current.version,
        expectedRevision: conversation.revision,
        expectedContextGeneration: current.contextGeneration,
        expectedActivationFence: conversation.activationFence,
        expectedNativeBindingGeneration: current.nativeBindingGeneration,
        deliveryReceiptId: accepted.receiptId,
        sourceBoundaries: current.sourceBoundaries
      })
      return { kind: 'activated', activation }
    } catch (error) {
      if (
        error instanceof ConversationRefusal &&
        (error.reason === 'stale-source' || error.reason === 'unverified-delivery')
      ) {
        return requireConversationSwitchReconciliation(store, current)
      }
      throw error
    }
  }

  const dispatch = async (
    intent: ConversationSwitchIntent,
    plan: ConversationSwitchPlan,
    signal: AbortSignal
  ): Promise<ConversationSwitchResult> => {
    signal.throwIfAborted()
    let reservationId: string | null = null
    if (plan.delivery === 'first-turn') {
      const reserved = await ports.reserveTrigger(intent, plan, signal)
      if (!reserved) {
        return { kind: 'waiting-trigger' }
      }
      reservationId = reserved.reservationId
    }
    signal.throwIfAborted()
    // Only the winner of this durable CAS may initiate the external effect.
    const delivering = await progress(intent, 'delivering', plan)
    let outcome: ConversationSwitchDelivery
    try {
      outcome = await ports.deliver(delivering, plan, reservationId, signal)
    } catch {
      return requireConversationSwitchReconciliation(store, delivering)
    }
    if (outcome.kind !== 'accepted') {
      return requireConversationSwitchReconciliation(store, delivering)
    }
    return activate(delivering, plan, outcome)
  }

  const recover = async (
    intent: ConversationSwitchIntent,
    plan: ConversationSwitchPlan,
    signal: AbortSignal
  ): Promise<ConversationSwitchResult> => {
    const current =
      intent.phase === 'reconciliation-required'
        ? intent
        : await store.markReconciliation(intent.operationKey, intent.version)
    const outcome = await ports.reconcile(current, plan, signal)
    if (outcome.kind === 'unknown' || outcome.kind === 'proven-no-effect') {
      return { kind: 'reconciliation-required' }
    }
    if (outcome.kind === 'accepted' && sourceMatches(current)) {
      return activate(current, plan, outcome)
    }
    const quiescence = await ports.quiesce(current, signal)
    if (quiescence.kind === 'blocked') {
      return quiescence
    }
    // A supplemental plan includes prior accepted coverage; it never replays the trigger.
    const prepared = await ports.prepare(current, plan.manifestId, signal)
    if (prepared.kind !== 'prepared') {
      return prepared
    }
    if (outcome.kind === 'accepted' && prepared.plan.delivery !== 'passive') {
      return { kind: 'blocked', reasons: ['passive-supplement-required'] }
    }
    const next = await progress(current, 'prepared', prepared.plan)
    return dispatch(next, prepared.plan, signal)
  }

  return {
    async advance(operationKey: string, signal: AbortSignal): Promise<ConversationSwitchResult> {
      signal.throwIfAborted()
      let intent = store.intent(operationKey)
      if (!intent) {
        throw new ConversationRefusal('missing-record')
      }
      if (intent.phase === 'cancelled') {
        return { kind: 'cancelled' }
      }
      if (intent.phase === 'activated') {
        const activationFence = intent.activationFence
        const segment = store
          .segments(intent.conversationId)
          .find((s) => s.activationFence === activationFence)
        if (!segment) {
          throw new ConversationRefusal('corrupt-record')
        }
        return {
          kind: 'activated',
          activation: {
            conversationId: intent.conversationId,
            segmentId: segment.segmentId,
            contextGeneration: intent.contextGeneration,
            activationFence: intent.activationFence
          }
        }
      }
      if (conversationSwitchNeedsReconciliation(intent)) {
        const plan = intent.manifestId && ports.readPlan(intent.manifestId)
        if (!plan) {
          return requireConversationSwitchReconciliation(store, intent)
        }
        return recover(intent, plan, signal)
      }
      const quiescence = await ports.quiesce(intent, signal)
      if (quiescence.kind === 'blocked') {
        return quiescence
      }
      let plan = intent.manifestId ? ports.readPlan(intent.manifestId) : null
      if (!plan || !sourceMatches(intent)) {
        const prepared = await ports.prepare(intent, intent.manifestId, signal)
        if (prepared.kind !== 'prepared') {
          return prepared
        }
        plan = prepared.plan
        intent = await progress(intent, 'prepared', plan)
      }
      return dispatch(intent, plan, signal)
    }
  }
}
