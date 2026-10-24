import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import type { ConversationTransferNoWriteProof } from './conversation-transfer-no-write'
import { commitConversationTransferRecovery } from './conversation-transfer-recovery'
import { isConversationTransferRecoveryOwner } from './conversation-transfer-recovery-authority'
import type {
  ConversationTransferRecoveryRequest,
  ConversationTransferRecoveryResult
} from '../../../shared/conversation-transfer-recovery'
import type { ConversationEnrollmentAcquisition } from './conversation-enrollment-native-origin'
import { ConversationArchiveStore } from './conversation-archive-store'
import { ConversationClearStore } from './conversation-clear-store'
import { beginConversationSwitch } from './conversation-begin-switch'
import type { AgentSessionReserveRequest } from '../../runtime/agent-session-reservation-admission'
import { ConversationTabSurfaceStore } from './conversation-tab-surface-store'
import type {
  ConversationDeliveryEvidenceReader,
  ConversationDeliveryCommit
} from './conversation-store-contracts'
import {
  cancelConversationSwitch,
  markConversationReconciliation
} from './conversation-cancellation'
import { captureConversationAcquisitionOrigin } from './conversation-origin-admission'
import { ensureConversationSingleton } from './conversation-singleton'
import { activateConversation } from './conversation-activation'
import {
  requireConversation,
  requireIntent,
  assertIntent,
  assertSources,
  allowedPhase,
  writeIntent
} from './conversation-store-transitions'
import type { JournalOperationReceipt } from '../agent-session-journal/journal-row-writer'
import {
  conversationSourceAttributionReceipt,
  readConversationSourceSpans
} from './conversation-source-attribution'
import type Database from '../../sqlite/sync-database'
import type { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import { pinJournalEpoch } from '../agent-session-journal/journal-epoch-pins'
import type { AgentSessionOperationDecision } from '../../../shared/agent-session-operation-ledger'
import type {
  ConversationRecord,
  ConversationSwitchIntent,
  ConversationActivationResult
} from '../../../shared/conversation-record'
import type {
  ConversationSwitchRequest,
  ConversationCancellationRequest,
  ConversationSwitchProgress,
  ConversationActivationRequest,
  ConversationSessionRoute
} from '../../../shared/conversation-wire'
import type { AgentSessionStoreTransactions } from '../../runtime/agent-session-store-transactions'
import type { AgentSessionStoreState } from '../../runtime/agent-session-store-state'
import type { AgentSessionOperationAdmission } from '../../runtime/agent-session-operation-admission'
import {
  ConversationRefusal,
  readConversation,
  readParticipant,
  readSegments,
  readSwitchIntent,
  readSourceBoundary,
  readConversationTimelinePage,
  readConversationSessionRoute,
  type ConversationTimelineCursor
} from './conversation-read-model'

export type * from './conversation-store-contracts'

export class ConversationStore {
  readonly archive: ConversationArchiveStore
  readonly clear: ConversationClearStore
  readonly surfaces: ConversationTabSurfaceStore
  constructor(
    private readonly host: JournalHostDatabase,
    private readonly transactions: AgentSessionStoreTransactions,
    private readonly deliveryEvidence: ConversationDeliveryEvidenceReader = () => null,
    private readonly deliveryCommit?: ConversationDeliveryCommit
  ) {
    this.surfaces = new ConversationTabSurfaceStore(host, transactions)
    this.archive = new ConversationArchiveStore(host, transactions)
    this.clear = new ConversationClearStore(host, transactions)
  }

  captureAcquisitionOrigin(sessionId: string) {
    return captureConversationAcquisitionOrigin(this.host.db, sessionId)
  }

  timelinePage(id: string, after: ConversationTimelineCursor | null = null, limit = 128) {
    return readConversationTimelinePage(this.host.db, id, after, limit)
  }

  read(id: string): ConversationRecord | null {
    return readConversation(this.host.db, id)
  }
  membership(sessionId: string) {
    return readParticipant(this.host.db, sessionId)
  }
  segments(id: string) {
    return readSegments(this.host.db, id)
  }
  intent(key: string): ConversationSwitchIntent | null {
    return readSwitchIntent(this.host.db, key)
  }

  sourceSpans(segmentId: string) {
    return readConversationSourceSpans(this.host.db, segmentId)
  }
  sourceAttributionReceipt(
    segmentId: string,
    sessionId: string,
    contextGeneration: number
  ): JournalOperationReceipt {
    return conversationSourceAttributionReceipt(segmentId, sessionId, contextGeneration)
  }
  route(sessionId: string): ConversationSessionRoute {
    return readConversationSessionRoute(this.host.db, sessionId)
  }

  async ensureSingleton(
    sessionId: string,
    acquisition?: ConversationEnrollmentAcquisition
  ): Promise<ConversationRecord> {
    let result: ConversationRecord | null = null
    await this.commit((db, state) => {
      result = ensureConversationSingleton(db, state, sessionId, acquisition)
    })
    if (!result) {
      throw new ConversationRefusal('missing-record')
    }
    return result
  }

  async beginSwitch(
    request: ConversationSwitchRequest,
    operation: AgentSessionOperationAdmission,
    founding?: AgentSessionReserveRequest
  ): Promise<{ decision: AgentSessionOperationDecision; intent: ConversationSwitchIntent | null }> {
    let result: {
      decision: AgentSessionOperationDecision
      intent: ConversationSwitchIntent | null
    } | null = null
    await this.commit((db, state) => {
      result = beginConversationSwitch(db, state, request, operation, founding)
    })
    if (!result) {
      throw new ConversationRefusal('missing-record')
    }
    return result
  }

  async progress(request: ConversationSwitchProgress): Promise<ConversationSwitchIntent> {
    let result: ConversationSwitchIntent | null = null
    await this.commit((db) => {
      const intent = requireIntent(db, request.operationKey)
      const conversation = requireConversation(db, intent.conversationId)
      assertIntent(conversation, intent, request.expectedVersion)
      if (!allowedPhase(intent.phase, request.phase)) {
        throw new ConversationRefusal('invalid-phase')
      }
      if (request.phase === 'activated' || request.phase === 'cancelled') {
        throw new ConversationRefusal('invalid-phase')
      }
      if (!intent.candidateSegmentId) {
        throw new ConversationRefusal('invalid-phase')
      }
      assertSources(db, intent, request.sourceBoundaries)
      if ((request.phase === 'prepared' || request.phase === 'delivering') && !request.manifestId) {
        throw new ConversationRefusal('invalid-phase')
      }
      for (const boundary of request.sourceBoundaries) {
        pinJournalEpoch(db, {
          ownerId: `conversation-switch:${intent.operationKey}:${intent.version + 1}`,
          ...boundary
        })
      }
      result = {
        ...intent,
        version: intent.version + 1,
        phase: request.phase,
        sourceBoundaries: request.sourceBoundaries,
        candidateBoundary: request.candidateBoundary ?? intent.candidateBoundary,
        manifestId: request.manifestId,
        deliveryReceiptId: request.deliveryReceiptId
      }
      const candidate = readSourceBoundary(db, intent.targetSessionId)
      if (JSON.stringify(candidate) !== JSON.stringify(result.candidateBoundary)) {
        throw new ConversationRefusal('stale-source')
      }
      writeIntent(db, result)
    })
    if (!result) {
      throw new ConversationRefusal('missing-record')
    }
    return result
  }

  /** Records uncertain effects even when late evidence invalidated the frozen projection. */
  async markReconciliation(
    operationKey: string,
    expectedVersion: number
  ): Promise<ConversationSwitchIntent> {
    let result: ConversationSwitchIntent | null = null
    await this.commit((db) => {
      result = markConversationReconciliation(db, operationKey, expectedVersion)
    })
    if (!result) {
      throw new ConversationRefusal('missing-record')
    }
    return result
  }

  currentTransferRecoveryFence(proof: ConversationTransferNoWriteProof): number | null {
    const record = this.transactions.state.records.get(proof.targetSessionId)
    return isConversationTransferRecoveryOwner(
      record,
      proof,
      this.transactions.state.records.get(proof.sourceSessionId)
    ) && record
      ? record.lease.runtimeFence
      : null
  }

  currentTransferRecoverySourceFence(proof: ConversationTransferNoWriteProof): number | null {
    return this.currentTransferRecoveryFence(proof) !== null
      ? (this.transactions.state.records.get(proof.sourceSessionId)?.lease.runtimeFence ?? null)
      : null
  }

  transferRecoveryReceipt(
    request: ConversationTransferRecoveryRequest,
    callerKey: string,
    sourceOwner: { runtimeFence: number; epoch: string },
    result: (value: ConversationTransferRecoveryResult) => void
  ): JournalOperationReceipt {
    let retirement: JournalRow | undefined
    const receipt = this.transactions.receipt((state) => {
      result(
        commitConversationTransferRecovery(
          this.host.db,
          state,
          request,
          callerKey,
          this.host.stateDirectory,
          retirement,
          sourceOwner
        )
      )
    })
    return {
      ...receipt,
      write: (db, row) => {
        retirement = row
        if (db !== this.host.db) {
          throw new Error('Transfer recovery store database changed')
        }
        receipt.write(db, row)
      }
    }
  }

  async cancel(request: ConversationCancellationRequest): Promise<ConversationSwitchIntent> {
    let result: ConversationSwitchIntent | null = null
    await this.commit((db, state) => {
      result = cancelConversationSwitch(db, state, request)
    })
    if (!result) {
      throw new ConversationRefusal('missing-record')
    }
    return result
  }

  async activate(request: ConversationActivationRequest): Promise<ConversationActivationResult> {
    let result: ConversationActivationResult | null = null
    await this.commit((db, state) => {
      result = activateConversation(db, state, request, this.deliveryEvidence, this.deliveryCommit)
    })
    if (!result) {
      throw new ConversationRefusal('missing-record')
    }
    return result
  }

  /** One store draft writes ledger changes after the DB-only conversation work, inside its transaction. */
  private async commit(
    write: (db: Database.Database, state: AgentSessionStoreState) => void
  ): Promise<void> {
    const receipt = this.transactions.receipt((state) => write(this.host.db, state))
    await this.transactions.commitReceipt(receipt)
  }
}
