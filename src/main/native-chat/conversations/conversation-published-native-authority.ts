import type Database from '../../sqlite/sync-database'
import { assertConversationOrigin, type ConversationOrigin } from './conversation-origin'
import {
  readConversation,
  readConversationSegment,
  readParticipant,
  readSwitchIntent
} from './conversation-read-model'
import { readConversationPublishedClearAuthority } from './conversation-clear-acquisition-origin'
import { readConversationPublishedEnrollmentAuthority } from './conversation-enrollment-native-origin'
import { readConversationPendingNativeAuthority } from './conversation-pending-native-authority'
import { readConversationTrigger } from './conversation-trigger-reservation'
import { assertConversationContinuationReceipt } from './conversation-continuation-authority'
import { readConversationDeliveryPlan } from './conversation-delivery-plan'
import { readConversationNativeBinding } from './conversation-origin-native-identity'

/** Publication survives activation, but never a native/context generation or acquisition change. */
export function assertConversationPublishedNativeAuthority(
  db: Database.Database,
  input: {
    sessionId: string
    operationKey: string
    origin: ConversationOrigin
    nativeIdentity: string
    fence: number
  }
) {
  const { origin, sessionId, operationKey } = input
  assertConversationOrigin(db, sessionId, origin)
  const participant = readParticipant(db, sessionId)
  const conversation = readConversation(db, origin.conversationId)
  const segment = readConversationSegment(db, origin.conversationId, origin.segmentId)
  if (
    !participant ||
    !conversation ||
    !segment ||
    participant.conversationId !== origin.conversationId ||
    participant.contextGeneration !== origin.contextGeneration ||
    participant.nativeBindingGeneration !== origin.nativeBindingGeneration ||
    conversation.contextGeneration !== origin.contextGeneration
  ) {
    throw new Error('published native generation changed')
  }
  if (segment.lifecycle === 'candidate') {
    const authority = readConversationPendingNativeAuthority(db, origin, sessionId, true)
    if (authority.operationKey !== operationKey) {
      throw new Error('published native candidate authority changed')
    }
    return
  }
  if (segment.lifecycle !== 'activated') {
    throw new Error('published native segment unverified')
  }
  const enrollment = readConversationPublishedEnrollmentAuthority(db, sessionId, origin.segmentId)
  if (
    enrollment?.operationKey === operationKey &&
    JSON.stringify(enrollment.origin) === JSON.stringify(origin)
  ) {
    return
  }
  const clear = readConversationPublishedClearAuthority(db, sessionId)
  if (
    clear?.operationKey === operationKey &&
    JSON.stringify(clear.origin) === JSON.stringify(origin)
  ) {
    return
  }
  const intent = readSwitchIntent(db, operationKey)
  const trigger = readConversationTrigger(db, operationKey)
  const binding = trigger?.binding
  const plan = binding && readConversationDeliveryPlan(db, binding.deliveryPlanId)
  const native = readConversationNativeBinding(db, sessionId)
  if (
    !intent ||
    intent.phase !== 'activated' ||
    intent.conversationId !== origin.conversationId ||
    intent.targetSessionId !== sessionId ||
    intent.candidateSegmentId !== origin.segmentId ||
    intent.contextGeneration !== origin.contextGeneration ||
    intent.nativeBindingGeneration !== origin.nativeBindingGeneration ||
    intent.activationFence !== segment.activationFence ||
    !binding ||
    !trigger ||
    !['appended', 'accepted'].includes(trigger.state) ||
    binding.conversationId !== origin.conversationId ||
    binding.candidateSegmentId !== origin.segmentId ||
    binding.targetSessionId !== sessionId ||
    binding.contextGeneration !== origin.contextGeneration ||
    binding.nativeBindingGeneration !== origin.nativeBindingGeneration ||
    binding.candidateGeneration !== segment.activationFence ||
    binding.manifestId !== intent.manifestId ||
    !plan ||
    plan.operationKey !== operationKey ||
    plan.manifestId !== intent.manifestId ||
    plan.manifestDigest !== binding.manifestDigest ||
    plan.targetSessionId !== sessionId ||
    plan.contextGeneration !== origin.contextGeneration ||
    plan.nativeBindingGeneration !== origin.nativeBindingGeneration ||
    !native ||
    native.digest !== input.nativeIdentity ||
    plan.nativeSessionId !== native.handle.nativeId ||
    (plan.transport === 'codex'
      ? 'codex-app-server'
      : plan.transport === 'claude'
        ? 'claude-sdk'
        : 'acp') !== native.handle.transport ||
    plan.runtimeFence !== input.fence
  ) {
    throw new Error('published native activation authority changed')
  }
  assertConversationContinuationReceipt(db, binding, intent)
}
