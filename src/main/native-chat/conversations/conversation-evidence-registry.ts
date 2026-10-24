import {
  retireConversationEvidenceRegistration,
  type ConversationEvidenceRegistrationEntry as Entry
} from './conversation-evidence-registration-lifetime'
import { randomUUID } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import type { ConversationDeliveryHost } from './conversation-delivery-plan'
import type {
  ConversationContextManifest,
  ConversationContextRepresentation
} from '../../../shared/conversation-handoff'
import { readConversation, readParticipant } from './conversation-read-model'
import { conversationContextDigest } from './conversation-context-consent'
import { assertConversationManifestPartAuthority } from './conversation-context-authority'
import {
  assertConversationEvidenceScope,
  type ConversationEvidenceHost
} from './conversation-evidence-scope'
import { openConversationEvidenceReader } from './conversation-evidence-reader'
import { ConversationExportError } from './conversation-export-error'
import {
  readConversationEvidenceTrustChoice,
  isConversationEvidenceTrustApproved,
  type ConversationEvidenceLaunchReader
} from './conversation-evidence-trust'
import {
  conversationEvidenceToolDefinition,
  conversationEvidenceToolInput,
  CONVERSATION_EVIDENCE_TOOL_SCHEMA_DIGEST
} from './conversation-evidence-tool-contract'

export type {
  ConversationEvidenceNativeOwner,
  ConversationEvidenceRegistration
} from './conversation-evidence-registration'
import type {
  ConversationEvidenceNativeOwner,
  ConversationEvidenceRegistration
} from './conversation-evidence-registration'
/** Host-owned registry. Registration confirmation is called by native transport adapters only. */
export function createConversationEvidenceRegistry(input: {
  db: Database.Database
  stateDirectory: string
  readLaunch: ConversationEvidenceLaunchReader
  readNative(sessionId: string): ConversationEvidenceNativeOwner | null
  deliveryHost(): ConversationDeliveryHost | null
}) {
  const { db, stateDirectory, readLaunch, readNative, deliveryHost } = input
  const entries = new Map<string, Entry>()
  const retire = (sessionId: string, entry: Entry) =>
    retireConversationEvidenceRegistration(entries, sessionId, entry)
  let calls = 0
  function readRegistration(sessionId: string): ConversationEvidenceRegistration | null {
    const entry = entries.get(sessionId)
    if (!entry || !entry.owner || entry.revoked) {
      return null
    }
    if (!entry.promoted) {
      try {
        entry.assertPending()
      } catch {
        void retire(sessionId, entry)
        return null
      }
    }
    if (!isConversationEvidenceTrustApproved(db, entry.choice)) {
      void retire(sessionId, entry)
      return null
    }
    const live = readNative(sessionId)
    if (!live || conversationContextDigest(live) !== conversationContextDigest(entry.owner)) {
      if (entry.promoted) {
        void retire(sessionId, entry)
      }
      return null
    }
    entry.promoted = true
    entry.detach()
    return {
      registrationId: entry.id,
      acquisitionGeneration: live.acquisitionGeneration,
      nativeSessionId: live.nativeSessionId,
      runtimeFence: live.runtimeFence,
      capabilityFingerprint: conversationContextDigest({
        base: live.baseCapabilityFingerprint,
        registrationId: entry.id,
        schema: CONVERSATION_EVIDENCE_TOOL_SCHEMA_DIGEST
      }),
      protocol: 'orca-evidence-v1',
      startupTrust: 'approved',
      transport: live.transport
    }
  }
  function host(): ConversationEvidenceHost {
    const current = deliveryHost()
    if (!current) {
      throw new ConversationExportError('scope')
    }
    return { ...current, readAcquisition: (id) => readRegistration(id) }
  }
  function canRetrieve(
    manifest: ConversationContextManifest,
    part: ConversationContextRepresentation
  ): boolean {
    const registration = readRegistration(manifest.target.sessionId)
    if (
      !registration ||
      registration.capabilityFingerprint !== manifest.target.capabilityFingerprint ||
      manifest.target.retrieval !== 'verified' ||
      part.representation === 'missing'
    ) {
      return false
    }
    try {
      assertConversationManifestPartAuthority(db, manifest, part)
      return true
    } catch {
      return false
    }
  }
  async function close(sessionId: string) {
    const entry = entries.get(sessionId)
    if (entry) {
      await retire(sessionId, entry)
    }
  }
  return {
    readRegistration,
    canRetrieve,
    close,
    prepare(
      sessionId: string,
      resuming: boolean,
      pending: { signal?: AbortSignal; assertScope?: () => void } = {}
    ) {
      pending.signal?.throwIfAborted()
      pending.assertScope?.()
      const existing = entries.get(sessionId)
      if (existing && !existing.revoked && !existing.owner) {
        return { kind: 'registration-pending' as const }
      }
      if (existing) {
        return {
          kind: readRegistration(sessionId)
            ? ('already-registered' as const)
            : ('registration-revoked' as const)
        }
      }
      if (entries.size >= 16) {
        throw new ConversationExportError('resource-limit')
      }
      const participant = readParticipant(db, sessionId)
      const conversation = participant && readConversation(db, participant.conversationId)
      if (!conversation?.pendingOperationKey) {
        return { kind: 'startup-trust-required' as const }
      }
      const choice = readConversationEvidenceTrustChoice(
        db,
        conversation.pendingOperationKey,
        readLaunch
      )
      if (
        choice.scope.targetSessionId !== sessionId ||
        !isConversationEvidenceTrustApproved(db, choice)
      ) {
        return { kind: 'startup-trust-required' as const }
      }
      if (resuming && choice.scope.transport === 'codex-dynamic-tool') {
        return { kind: 'native-rebuild-required' as const }
      }
      const entry: Entry = {
        id: randomUUID(),
        choice: structuredClone(choice),
        owner: null,
        controller: new AbortController(),
        revoked: false,
        reader: null,
        planId: null,
        bindingRevision: 0,
        cleanup: null,
        promoted: false,
        assertPending: () => {
          pending.signal?.throwIfAborted()
          pending.assertScope?.()
        },
        detach: () => pending.signal?.removeEventListener('abort', abortPending)
      }
      function abortPending() {
        void retire(sessionId, entry)
      }
      pending.signal?.addEventListener('abort', abortPending, { once: true })
      entries.set(sessionId, entry)
      return {
        kind: 'pending' as const,
        close: () => close(sessionId),
        definition: conversationEvidenceToolDefinition(),
        /** Call only after the owned tool was actually attached by the selected native contract. */
        confirm(observed: ConversationEvidenceNativeOwner) {
          entry.assertPending()
          if (
            entries.get(sessionId) !== entry ||
            entry.revoked ||
            entry.owner ||
            observed.transport !== choice.scope.transport ||
            observed.launchFingerprint !== choice.scope.launchFingerprint ||
            !observed.acquisitionGeneration ||
            !observed.nativeSessionId ||
            !observed.baseCapabilityFingerprint ||
            !Number.isSafeInteger(observed.runtimeFence) ||
            observed.runtimeFence < 1 ||
            !isConversationEvidenceTrustApproved(db, choice)
          ) {
            throw new ConversationExportError('scope')
          }
          entry.owner = structuredClone(observed)
        },
        async invoke(raw: unknown, signal: AbortSignal) {
          signal.throwIfAborted()
          const registration = readRegistration(sessionId)
          if (!registration || entries.get(sessionId) !== entry || !entry.planId) {
            throw new ConversationExportError('scope')
          }
          if (calls >= 4) {
            throw new ConversationExportError('resource-limit')
          }
          const request = conversationEvidenceToolInput.parse(raw)
          if (request.action === 'read' && !request.source) {
            throw new ConversationExportError('scope')
          }
          const planId = entry.planId
          const reader = (entry.reader ??= openConversationEvidenceReader(
            {
              db,
              stateDirectory,
              planId,
              host: host(),
              acquisitionGeneration: registration.acquisitionGeneration
            },
            entry.controller.signal
          ))
          calls++
          try {
            const response =
              request.action === 'read' && request.source
                ? await reader.read(
                    { source: request.source, cursor: request.cursor, maxBytes: request.maxBytes },
                    signal
                  )
                : reader.list(request.cursor)
            signal.throwIfAborted()
            if (entry.planId !== planId || !readRegistration(sessionId)) {
              throw new ConversationExportError('scope')
            }
            return response
          } finally {
            calls--
          }
        }
      }
    },
    async bindPlan(sessionId: string, planId: string) {
      const entry = entries.get(sessionId),
        registration = readRegistration(sessionId)
      if (!entry || !registration) {
        throw new ConversationExportError('scope')
      }
      const scope = assertConversationEvidenceScope(
        db,
        planId,
        host(),
        registration.acquisitionGeneration
      )
      if (scope.plan.targetSessionId !== sessionId) {
        throw new ConversationExportError('scope')
      }
      if (entry.planId !== planId) {
        const revision = ++entry.bindingRevision
        await entry.reader?.close()
        const current = readRegistration(sessionId)
        if (
          entries.get(sessionId) !== entry ||
          entry.revoked ||
          revision !== entry.bindingRevision ||
          current?.registrationId !== registration.registrationId
        ) {
          throw new ConversationExportError('scope')
        }
        const checked = assertConversationEvidenceScope(
          db,
          planId,
          host(),
          registration.acquisitionGeneration
        )
        if (checked.plan.targetSessionId !== sessionId) {
          throw new ConversationExportError('scope')
        }
        entry.reader = null
        entry.planId = planId
      }
    }
  }
}
