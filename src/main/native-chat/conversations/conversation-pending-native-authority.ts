import type Database from '../../sqlite/sync-database'
import { readConversationClearAcquisitionAuthority } from './conversation-clear-acquisition-origin'
import { readConversationEnrollmentNativeAuthority } from './conversation-enrollment-native-origin'
import { assertConversationOrigin, type ConversationOrigin } from './conversation-origin'
import { readConversation, readSwitchIntent } from './conversation-read-model'

export function readConversationFreshCandidateAuthority(
  db: Database.Database,
  origin: ConversationOrigin,
  sessionId: string,
  proofRead = false
) {
  assertConversationOrigin(db, sessionId, origin)
  const conversation = readConversation(db, origin.conversationId)
  const intent = conversation?.pendingOperationKey
    ? readSwitchIntent(db, conversation.pendingOperationKey)
    : null
  if (
    !intent ||
    intent.targetSessionId !== sessionId ||
    intent.candidateSegmentId !== origin.segmentId ||
    intent.contextGeneration !== origin.contextGeneration ||
    intent.nativeBindingGeneration !== origin.nativeBindingGeneration ||
    conversation?.contextGeneration !== origin.contextGeneration ||
    !(
      proofRead
        ? ['quiescing', 'prepared', 'delivering', 'reconciliation-required']
        : ['quiescing', 'prepared']
    ).includes(intent.phase)
  ) {
    throw new Error('pending native candidate changed')
  }
  return intent
}
export function readConversationPendingNativeAuthority(
  db: Database.Database,
  origin: ConversationOrigin,
  sessionId: string,
  proofRead = false
) {
  const clear = readConversationClearAcquisitionAuthority(db, sessionId)
  if (clear && JSON.stringify(clear.origin) === JSON.stringify(origin)) {
    return {
      kind: 'clear' as const,
      operationKey: clear.operationKey
    }
  }
  const enrollment = readConversationEnrollmentNativeAuthority(db, sessionId)
  if (enrollment && JSON.stringify(enrollment.origin) === JSON.stringify(origin)) {
    return { kind: 'enrollment' as const, operationKey: enrollment.operationKey }
  }
  return {
    kind: 'switch' as const,
    operationKey: readConversationFreshCandidateAuthority(db, origin, sessionId, proofRead)
      .operationKey
  }
}
