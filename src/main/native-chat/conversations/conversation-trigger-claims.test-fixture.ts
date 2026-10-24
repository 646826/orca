import { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import { createAgentSessionUploadOwnership } from '../agent-session-attachments/agent-session-upload-provenance'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { beginSwitch } from '../agent-session-wire/structured-conversation-switch.test-fixture'
import {
  CALLER,
  envelope,
  hostTestState
} from '../agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION,
  hostTestMessage
} from '../agent-session-wire/structured-agent-session-host-test-data'
import { compileConversationContext } from './conversation-context-policy'
import {
  conversationContextAccountDigest,
  conversationContextSourceRevision,
  type ConversationContextEvidenceReader
} from './conversation-context-authority'
import { conversationContextDigest } from './conversation-context-consent'
import { saveConversationManifest } from './conversation-context-coverage'
import { prepareConversationDeliveryPlan } from './conversation-delivery-plan'

export async function triggerClaimsFixture(
  createBody?: (
    stateDirectory: string,
    storeFile: (name: string, text: string) => Promise<string>
  ) => Promise<AgentJournalMessageItem>,
  targetFixture?: Parameters<typeof beginSwitch>[1],
  startSwitch: () => ReturnType<typeof beginSwitch> = () => beginSwitch(undefined, targetFixture),
  sourceOptions?: Record<string, string>
) {
  const { host, store, targetId, intent } = await startSwitch()
  const db = host.deps.journalDatabase.db
  const target = store.getRecord(targetId)!
  const compiled = compileConversationContext({
    conversationId: intent.conversationId,
    contextGeneration: intent.contextGeneration,
    sourceRevision: conversationContextSourceRevision(db, intent.conversationId, targetId),
    target: {
      sessionId: targetId,
      provider: target.provider,
      accountBindingDigest: conversationContextAccountDigest(target),
      nativeBindingGeneration: 1,
      capabilityFingerprint: 'fixture-first-turn',
      model: 'fixture',
      retrieval: 'unsupported'
    },
    policy: 'fresh',
    originals: [],
    projection: [],
    mandatory: [],
    budget: null,
    countTokens: (text) => text.length,
    now: 1,
    signal: new AbortController().signal
  })
  if (compiled.kind !== 'compiled') {
    throw new Error('fresh fixture manifest refused')
  }
  const manifest = compiled.manifest
  const readPreparationEvidence: ConversationContextEvidenceReader = (_db, requested) =>
    requested.digest === manifest.digest
      ? {
          proofId: 'fixture-native-first-turn',
          manifestDigest: manifest.digest,
          targetBindingDigest: manifest.targetBindingDigest,
          capabilityFingerprint: manifest.target.capabilityFingerprint,
          contextGeneration: 1,
          sourceRevision: manifest.sourceRevision,
          budgetDigest: conversationContextDigest(null)
        }
      : null
  host.deps.journalDatabase.transaction((db) =>
    saveConversationManifest(db, manifest, null, readPreparationEvidence)
  )
  const prepared = await store.conversations.progress({
    operationKey: intent.operationKey,
    expectedVersion: intent.version,
    phase: 'prepared',
    sourceBoundaries: intent.sourceBoundaries,
    manifestId: manifest.manifestId,
    deliveryReceiptId: null
  })
  const deliveryHost = {
    getRecord: (id: string) => store.getRecord(id),
    getJournal: (id: string) => host.collaboratorsForTests().sessions.get(id)?.journal ?? null,
    readPreparationEvidence,
    readPreDispatchPreparationEvidence: readPreparationEvidence,
    canRetrieve: () => false
  }
  const plan = await prepareConversationDeliveryPlan(
    db,
    {
      operationKey: intent.operationKey,
      manifestId: manifest.manifestId,
      expectedIntentVersion: prepared.version
    },
    deliveryHost,
    new AbortController().signal
  )
  const body = createBody
    ? await createBody(host.deps.journalDatabase.stateDirectory, (name, text) => {
        const uploads = new AgentSessionAttachmentStore(
          agentSessionAttachmentStoreRoot(host.deps.journalDatabase.stateDirectory),
          {
            hasSession: (id) => store.getRecord(id) !== null,
            ownership: createAgentSessionUploadOwnership(() => db)
          }
        )
        return uploads.storeFile(name, Buffer.from(text), { sessionId: HOST_TEST_SESSION })
      })
    : hostTestMessage('original triggering intent')
  const sent = await host.send(CALLER, {
    envelope: envelope('agentSession.send', {
      body,
      delivery: 'queue-if-active',
      ...(sourceOptions ? { options: sourceOptions } : {})
    }),
    body,
    ...(sourceOptions ? { options: sourceOptions } : {}),
    delivery: 'queue-if-active',
    userSend: true
  })
  if (!sent.ok) {
    throw new Error('fixture draft refused')
  }
  const source = host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
  const draft = source.queuedMessages.list()[0]!
  return {
    host,
    store,
    db,
    manifest,
    plan,
    source,
    draft,
    targetId,
    intent: prepared,
    deliveryHost,
    claimsHost: {
      stateDirectory: host.deps.journalDatabase.stateDirectory,
      getRecord: deliveryHost.getRecord,
      getJournal: deliveryHost.getJournal,
      readPreparationEvidence
    },
    request: {
      transferId: 'fixture-transfer',
      kind: 'trigger' as const,
      operationKey: intent.operationKey,
      deliveryPlanId: plan.planId,
      queueSessionId: HOST_TEST_SESSION,
      messageId: draft.messageId,
      targetSubmissionId: 'fixture-trigger-submission'
    },
    dispatch: hostTestState().dispatch
  }
}
