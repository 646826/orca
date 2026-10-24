import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import { bindConversationOrigin } from './conversation-origin'
import {
  conversationContextAccountDigest,
  type ConversationContextEvidenceReader
} from './conversation-context-authority'
import type Database from '../../sqlite/sync-database'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { readPinnedQueuedMessageEvidence } from '../agent-session-journal/queued-message-origin'
import type { ConversationQueueView } from '../agent-session-wire/structured-conversation-source-queue'
import { runJournalTransaction } from '../agent-session-journal/journal-transaction'
import {
  agentSessionAttachmentReferences,
  agentSessionAttachmentStoreRoot
} from '../agent-session-attachments/agent-session-attachment-references'
import { readConversationManifest } from './conversation-context-coverage'
import { conversationContextDigest } from './conversation-context-consent'
import {
  readConversationDeliveryPlan,
  conversationDeliveryEnvelope
} from './conversation-delivery-plan'
import { readSwitchIntent } from './conversation-read-model'
import {
  readConversationTransfer,
  reserveConversationTrigger,
  type ConversationTriggerAuthority
} from './conversation-trigger-reservation'
import type { ConversationTriggerBinding } from './conversation-trigger-schema'
import {
  captureConversationTriggerAttachments,
  readConversationTriggerAttachments
} from './conversation-trigger-attachments'

export type ConversationTriggerClaimsHost = {
  stateDirectory: string
  getRecord: (sessionId: string) => AgentSessionRecord | null
  getJournal: (sessionId: string) => ConversationQueueView | null
  readPreparationEvidence: ConversationContextEvidenceReader
}

function material(
  db: Database.Database,
  host: ConversationTriggerClaimsHost,
  binding: ConversationTriggerBinding
) {
  const plan = readConversationDeliveryPlan(db, binding.deliveryPlanId)
  const manifest = readConversationManifest(db, binding.manifestId)
  const evidenceInput = {
    sourceSessionId: binding.queueSessionId,
    messageId: binding.messageId,
    fingerprint: binding.sourceFingerprint
  }
  const draft = readConversationTransfer(db, binding.transferId)
    ? readPinnedQueuedMessageEvidence(db, {
        ...evidenceInput,
        ownerId: `conversation-transfer:${binding.transferId}`
      })
    : host.getJournal(binding.queueSessionId)?.queuedMessages.get(binding.messageId)
  const target = host.getRecord(binding.targetSessionId)
  if (
    !plan ||
    !manifest ||
    !draft ||
    !target ||
    plan.operationKey !== binding.operationKey ||
    plan.manifestId !== manifest.manifestId ||
    plan.manifestDigest !== binding.manifestDigest ||
    manifest.digest !== binding.manifestDigest ||
    plan.targetSessionId !== binding.targetSessionId ||
    plan.contextGeneration !== binding.contextGeneration ||
    plan.nativeBindingGeneration !== binding.nativeBindingGeneration ||
    draft.body.role !== 'user' ||
    draft.body.command ||
    agentSessionSendBodyFingerprint(binding.queueSessionId, draft.body) !==
      binding.sourceFingerprint ||
    draft.fingerprint !== binding.sourceFingerprint
  ) {
    throw new Error('Trigger payload authority changed')
  }
  const head = agentSessionProviderHandleChainHead(target.providerHandleChain)
  if (
    !head ||
    target.lease.unreconciled ||
    target.lease.claimStatus !== 'live' ||
    target.lease.runtimeFence !== plan.runtimeFence ||
    conversationContextDigest({ head, account: conversationContextAccountDigest(target) }) !==
      plan.nativeIdentityDigest
  ) {
    throw new Error('Trigger native identity changed')
  }
  const body: AgentJournalMessageItem =
    binding.kind === 'queued-continuation'
      ? draft.body
      : {
          ...draft.body,
          blocks: [
            { type: 'text', text: conversationDeliveryEnvelope(manifest, plan.inlineDeltaKeys) },
            ...draft.body.blocks
          ]
        }
  return { body, options: target.options, draft }
}

/** Host-derived body/options and immutable claims; never a caller's accepted=true assertion. */
export function createConversationTriggerAuthority(
  input: ConversationTriggerClaimsHost
): ConversationTriggerAuthority {
  const host = {
    stateDirectory: input.stateDirectory,
    getRecord: input.getRecord.bind(input),
    getJournal: input.getJournal.bind(input),
    readPreparationEvidence: input.readPreparationEvidence
  }
  return {
    readPreparationEvidence: host.readPreparationEvidence,
    readSourceCard: (sessionId, messageId) =>
      host.getJournal(sessionId)?.queuedMessages.get(messageId) ?? null,
    verifyTriggerClaims(db, binding, row) {
      try {
        const { body, options, draft } = material(db, host, binding)
        const transfer = readConversationTransfer(db, binding.transferId)
        if (!transfer || transfer.state === 'reserved') {
          const live = host
            .getJournal(binding.queueSessionId)
            ?.queuedMessages.get(binding.messageId)
          if (
            !live ||
            live.state !== binding.expectedQueueState ||
            live.fingerprint !== binding.sourceFingerprint
          ) {
            return false
          }
        } else if (
          !['appended', 'uncertain', 'accepted', 'proven-no-effect'].includes(transfer.state)
        ) {
          return false
        }
        if (
          agentSessionSendBodyFingerprint(binding.targetSessionId, body) !==
            binding.targetFingerprint ||
          conversationContextDigest(options ?? null) !== binding.targetOptionsDigest
        ) {
          return false
        }
        const claims = readConversationTriggerAttachments(db, binding.transferId)
        const references = [
          ...agentSessionAttachmentReferences(
            agentSessionAttachmentStoreRoot(host.stateDirectory),
            draft.body
          )
        ].sort()
        if (
          conversationContextDigest(claims) !== binding.attachmentClaimsDigest ||
          conversationContextDigest([...new Set(claims.map((c) => c.uploadId))].sort()) !==
            conversationContextDigest(references)
        ) {
          return false
        }
        if (
          row &&
          (row.clientMessageId !== binding.targetSubmissionId ||
            row.payloadFingerprint !== binding.targetFingerprint ||
            conversationContextDigest(row.body) !== conversationContextDigest(body) ||
            conversationContextDigest(row.options ?? null) !== binding.targetOptionsDigest)
        ) {
          return false
        }
        return true
      } catch {
        return false
      }
    }
  }
}

/** Hash uploads outside queues, then reserve one exact immutable draft/envelope and its claims. */
export async function prepareConversationTrigger(
  db: Database.Database,
  request: {
    transferId: string
    kind: ConversationTriggerBinding['kind']
    operationKey: string
    deliveryPlanId: string
    queueSessionId: string
    messageId: string
    targetSubmissionId: string
  },
  inputHost: ConversationTriggerClaimsHost,
  _now: number,
  signal: AbortSignal
) {
  if (db.isTransaction) {
    throw new Error('Trigger preparation cannot wait in a transaction')
  }
  const host = {
    stateDirectory: inputHost.stateDirectory,
    getRecord: inputHost.getRecord.bind(inputHost),
    getJournal: inputHost.getJournal.bind(inputHost),
    readPreparationEvidence: inputHost.readPreparationEvidence
  }
  const input = { ...request }
  const plan = readConversationDeliveryPlan(db, input.deliveryPlanId)
  const intent = readSwitchIntent(db, input.operationKey)
  const draft = host.getJournal(input.queueSessionId)?.queuedMessages.get(input.messageId)
  if (
    !plan ||
    !intent?.candidateSegmentId ||
    !draft ||
    (draft.state !== 'waiting' && draft.state !== 'returned')
  ) {
    throw new Error('Trigger preparation is unavailable')
  }
  const versions = await captureConversationTriggerAttachments(
    host.stateDirectory,
    draft.body,
    signal
  )
  signal.throwIfAborted()
  const binding: ConversationTriggerBinding = {
    ...input,
    conversationId: intent.conversationId,
    contextGeneration: intent.contextGeneration,
    candidateGeneration: intent.activationFence,
    candidateSegmentId: intent.candidateSegmentId,
    nativeBindingGeneration: intent.nativeBindingGeneration,
    sourceFingerprint: draft.fingerprint,
    expectedQueueState: draft.state,
    targetSessionId: intent.targetSessionId,
    manifestId: plan.manifestId,
    manifestDigest: plan.manifestDigest,
    targetFingerprint: '',
    targetOptionsDigest: '',
    attachmentClaimsDigest: conversationContextDigest(versions)
  }
  const payload = material(db, host, binding)
  binding.targetFingerprint = agentSessionSendBodyFingerprint(binding.targetSessionId, payload.body)
  binding.targetOptionsDigest = conversationContextDigest(payload.options ?? null)
  const authority = createConversationTriggerAuthority(host)
  runJournalTransaction(db, () => {
    if (
      conversationContextDigest(readConversationTriggerAttachments(db, binding.transferId)) !==
      binding.attachmentClaimsDigest
    ) {
      throw new Error('Trigger attachments must be staged before manifest authorization')
    }
    reserveConversationTrigger(db, binding, authority)
    bindConversationOrigin(db, {
      sessionId: binding.targetSessionId,
      key: { kind: 'submission', id: binding.targetSubmissionId },
      origin: {
        conversationId: binding.conversationId,
        segmentId: binding.candidateSegmentId,
        contextGeneration: binding.contextGeneration,
        nativeBindingGeneration: binding.nativeBindingGeneration
      }
    })
  })
  return { binding, body: payload.body, options: payload.options, authority }
}
