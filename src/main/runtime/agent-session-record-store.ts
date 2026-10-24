import { publishAgentSessionProviderHandle } from './agent-session-provider-handle-publication'
import {
  proveAgentSessionOwnerWithOrigin,
  type AgentSessionOwnerProof
} from './agent-session-owner-proof'
import {
  ConversationStore,
  type ConversationDeliveryEvidenceReader,
  type ConversationDeliveryCommit
} from '../native-chat/conversations/conversation-store'
/** Durable single-writer session records and their operation ledger, as rows in the host's chat
 *  journal database. */

import { backfillAgentSessionPermissionModes } from './agent-session-permission-backfill'
import { mutateAgentSessionStoreRecord } from './agent-session-store-draft'
import { createAgentSessionConversationReceipts } from './agent-session-conversation-receipts'
import { pinAgentSessionRecordLaunchDirectory } from './agent-session-record-launch-directory'
import {
  agentSessionOperationKey,
  type AgentSessionOperationDecision,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import {
  admitAgentSessionGlobalOperationInto,
  admitAgentSessionMutationOperation,
  evaluateAgentSessionMutationOperation,
  admitAgentSessionOperationInto,
  claimAgentSessionOperationInto,
  admitAndClaimAgentSessionOperationInto,
  type ClaimAfterAdmission,
  settleAgentSessionOperationInto,
  type AgentSessionMutationOperationAdmission,
  type AgentSessionOperationAdmission
} from './agent-session-operation-admission'
import {
  isAgentSessionClaimKeyVerifiable,
  retireAgentSessionClaimKey
} from './agent-session-claim-key-retention'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import {
  agentSessionScopeKey,
  type AgentSessionExecutionLocation,
  type AgentSessionOptionsReplacement,
  type AgentSessionRecord
} from '../../shared/agent-session-record'
import {
  commitAgentSessionProcessIdentity,
  evictAgentSessionOwner,
  type AgentSessionProcessIdentityCommit
} from './agent-session-lease-transitions'
import {
  settleFailedAgentSessionAcquisition,
  settleFailedAgentSessionPostAcquisitionAttachment,
  type AgentSessionFailedAcquisitionSettlement,
  type AgentSessionFailedPostAcquisitionAttachmentSettlement
} from './agent-session-acquisition-failure-settlement'
import {
  renewAgentSessionLeases,
  type AgentSessionLeaseRenewal
} from './agent-session-lease-renewal'
import {
  applyAgentSessionRestartProbes,
  collectAgentSessionRestartProbes,
  type AgentSessionRestartProbeArgs
} from './agent-session-restart-reconciliation'
import { replaceAgentSessionRecordOptions } from './agent-session-record-options'
import {
  commitAgentSessionReservation,
  type AgentSessionReserveRequest,
  type AgentSessionReserveResult
} from './agent-session-reservation-admission'
import { heldAgentSessionIds, type AgentSessionStoreState } from './agent-session-store-state'
import {
  agentSessionVisibleTabIndex,
  listVisibleAgentSessionIds,
  setAgentSessionTabVisibility,
  showAgentSessionTabs
} from './agent-session-tab-table'
import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import type { JournalOperationReceipt } from '../native-chat/agent-session-journal/journal-row-writer'
import { agentSessionOperationOutcomeReceipt } from './agent-session-operation-receipt'
import { loadAgentSessionStoreRows } from './agent-session-record-rows'
import { AgentSessionStoreTransactions } from './agent-session-store-transactions'
import { createAgentSessionFoundingStore } from './agent-session-founding-store'
import {
  compareAndSetAgentSessionRecordName,
  type CompareAndSetConversationName,
  setAgentSessionRecordConversationName
} from './agent-session-record-conversation-name'

export const AGENT_SESSION_LEASE_TTL_MS = 30_000,
  AGENT_SESSION_LEASE_RENEW_INTERVAL_MS = 10_000

export class AgentSessionRecordStore {
  private readonly deathEvidenceListeners = new Set<(sessionId: string) => void>()
  private readonly firstRecordListeners = new Set<() => void>()
  readonly conversationReceipts: ReturnType<typeof createAgentSessionConversationReceipts>

  private constructor(
    private readonly transactions: AgentSessionStoreTransactions,
    readonly hostId: string,
    readonly conversations: ConversationStore
  ) {
    this.founding = createAgentSessionFoundingStore(transactions, this.firstRecordListeners)
    this.conversationReceipts = createAgentSessionConversationReceipts(transactions)
  }

  /** Reads every structurally valid row, independently of which agents this host can start. */
  static open(args: {
    journalDatabase: JournalHostDatabase
    hostId: string
    conversationDeliveryEvidence?: ConversationDeliveryEvidenceReader
    conversationDeliveryCommit?: ConversationDeliveryCommit
  }): AgentSessionRecordStore {
    const rows = loadAgentSessionStoreRows(args.journalDatabase.db)
    const transactions = new AgentSessionStoreTransactions(args.journalDatabase, rows, args.hostId)
    return new AgentSessionRecordStore(
      transactions,
      args.hostId,
      new ConversationStore(
        args.journalDatabase,
        transactions,
        args.conversationDeliveryEvidence,
        args.conversationDeliveryCommit
      )
    )
  }

  private get state(): AgentSessionStoreState {
    return this.transactions.state
  }

  /** A newer Orca wrote the database: every read answers, and every write is refused. */
  get readOnly(): boolean {
    return this.transactions.readOnly
  }

  hasOperationInOrder(callerKey: string, operationId: string): Promise<boolean> {
    return this.transactions.readInOrder((state) =>
      state.operations.has(agentSessionOperationKey(callerKey, operationId))
    )
  }

  backfillChatPermissionModes = (ranWithFullAccess: (provider: string) => boolean): Promise<void> =>
    backfillAgentSessionPermissionModes(this.transactions, ranWithFullAccess)

  getRecord = (sessionId: string): AgentSessionRecord | null =>
    this.state.records.get(sessionId) ?? null

  listRecords = (): AgentSessionRecord[] => [...this.state.records.values()]

  /** The runtimes this one replaced for a chat, as found at load; absent for a chat it began. */
  replacedRuntime = (sessionId: string) => this.transactions.replacedRuntimes.get(sessionId)

  /** Every chat this host holds a row for, readable or not. */
  listHeldSessionIds = (): string[] => heldAgentSessionIds(this.state)

  /** Whether this host has recorded a chat, readable or not. Nothing removes a record row. */
  holdsRecords = (): boolean => this.state.records.size > 0 || this.state.unreadableRecords.size > 0

  listVisibleSessionIds = (): string[] => listVisibleAgentSessionIds(this.state)

  getVisibleSessionTabIndex = (): { present: boolean; sessionIds: string[] } =>
    agentSessionVisibleTabIndex(this.state)

  /** The id of the chat tab showing this conversation, if one does. */
  getSessionTabId = (sessionId: string): string | null =>
    this.state.sessionTabs?.tabIdFor(sessionId) ?? null

  /**
   * Persist the user-visible tab reference separately from the rollback-sensitive profile tabs.
   * Showing keeps a tab the session already has; `tabId` puts a hidden one back under its old id.
   */
  setSessionTabVisibility(
    sessionId: string,
    visible: boolean,
    tabId?: string,
    assertMutationSupported?: () => void
  ): Promise<void> {
    return this.transact((draft) => {
      assertMutationSupported?.()
      setAgentSessionTabVisibility(draft, sessionId, visible, tabId)
    })
  }

  /** Shows each session that still has a record, in one write: an index written part way would
   *  read as complete at the next launch and drop the rest. */
  showSessionTabs(sessionIds: readonly string[]): Promise<void> {
    return this.transact((draft) => showAgentSessionTabs(draft, sessionIds))
  }

  listByScope(location: AgentSessionExecutionLocation): AgentSessionRecord[] {
    const scope = agentSessionScopeKey(location)
    return this.listRecords().filter((record) => agentSessionScopeKey(record.location) === scope)
  }

  /** Unfenced on purpose: the name is a durable note, so writing it never contends with the
   *  writer lease. `null` clears it. */
  setConversationName = (sessionId: string, name: string | null): Promise<AgentSessionRecord> =>
    this.mutate(sessionId, (record) =>
      setAgentSessionRecordConversationName(record, name, Date.now())
    )

  compareAndSetConversationName: CompareAndSetConversationName = (sessionId, name, expected) =>
    compareAndSetAgentSessionRecordName((apply) => this.mutate(sessionId, apply), name, expected)

  /** Unfenced like the name: it records where a launch ran and never contends with the lease. */
  pinLaunchDirectory = (sessionId: string, launchDirectory: string): Promise<AgentSessionRecord> =>
    this.mutate(sessionId, (record) =>
      pinAgentSessionRecordLaunchDirectory(record, launchDirectory, Date.now())
    )

  /** A record this build cannot validate: readable as present, never grantable as a writer. */
  isSessionUnreadable = (sessionId: string): boolean => this.state.unreadableRecords.has(sessionId)

  listOperationRows = (): AgentSessionOperationRow[] => [...this.state.operations.values()]

  getOperationRow = (callerKey: string, operationId: string): AgentSessionOperationRow | null =>
    this.state.operations.get(agentSessionOperationKey(callerKey, operationId)) ?? null

  isClaimKeyVerifiable = (keyId: string, now: number): boolean =>
    isAgentSessionClaimKeyVerifiable(this.state, keyId, now)

  reserveOwner = (request: AgentSessionReserveRequest): Promise<AgentSessionReserveResult> =>
    this.transact((draft) =>
      commitAgentSessionReservation(draft, request, AGENT_SESSION_LEASE_TTL_MS)
    )

  readonly founding: ReturnType<typeof createAgentSessionFoundingStore>

  commitProcessIdentity = (args: AgentSessionProcessIdentityCommit): Promise<AgentSessionRecord> =>
    this.mutate(args.sessionId, (record) => commitAgentSessionProcessIdentity({ ...args, record }))

  proveOwner = (args: AgentSessionOwnerProof): Promise<AgentSessionRecord> =>
    proveAgentSessionOwnerWithOrigin(this.transactions, args, AGENT_SESSION_LEASE_TTL_MS)

  /** Settle the failed attach and its reservation in one durable transaction. */
  settleFailedAcquisition = (args: AgentSessionFailedAcquisitionSettlement) =>
    this.transact((draft) => settleFailedAgentSessionAcquisition(draft, args))

  settleFailedPostAcquisitionAttachment = (
    args: AgentSessionFailedPostAcquisitionAttachmentSettlement
  ) => this.transact((draft) => settleFailedAgentSessionPostAcquisitionAttachment(draft, args))

  renewLease = (args: AgentSessionLeaseRenewal): Promise<AgentSessionRecord> =>
    this.renewLeases([args]).then(([renewed]) => renewed)

  async renewLeases(renewals: readonly AgentSessionLeaseRenewal[]): Promise<AgentSessionRecord[]> {
    return this.transact((draft) =>
      renewAgentSessionLeases(draft, renewals, AGENT_SESSION_LEASE_TTL_MS)
    )
  }

  async evictProvenDeadOwner(args: {
    sessionId: string
    expectedFence: number
    probe: AgentSessionOwnerProbe
    now: number
  }): Promise<AgentSessionRecord> {
    return this.mutate(args.sessionId, (record) => evictAgentSessionOwner({ ...args, record }))
  }

  publishProviderHandle = (input: Parameters<typeof publishAgentSessionProviderHandle>[1]) =>
    publishAgentSessionProviderHandle(this.transactions, input)

  transitionHandoff = (
    sessionId: string,
    transition: (record: AgentSessionRecord) => AgentSessionRecord
  ): Promise<AgentSessionRecord> => this.mutate(sessionId, transition)

  /**
   * Adjudicate loaded leases, or only the addressed session. No lease grants a writer until it
   * appears here. On a newer database, verdicts stay in memory only: they are re-derived at every
   * start, and none grants a writer there, since every grant is a write.
   */
  async reconcileOnRestart(
    args: AgentSessionRestartProbeArgs
  ): Promise<Map<string, AgentSessionRecord>> {
    const probes = await collectAgentSessionRestartProbes(this, args)
    return this.transact((draft) => applyAgentSessionRestartProbes(draft, probes, args.now), {
      inMemoryWhenReadOnly: true
    })
  }

  /** Admits one non-reservation mutation through the durable ledger. */
  admitOperation = (args: AgentSessionOperationAdmission): Promise<AgentSessionOperationDecision> =>
    this.transact((draft) => admitAgentSessionOperationInto(draft, args))

  /** Send ids stay global after a caller reconnects under a different identity. */
  admitGlobalOperation = (
    args: AgentSessionOperationAdmission
  ): Promise<AgentSessionOperationDecision> =>
    this.transact((draft) => admitAgentSessionGlobalOperationInto(draft, args))

  admitMutationOperation = (args: AgentSessionMutationOperationAdmission) =>
    this.transact((draft) => admitAgentSessionMutationOperation(draft, args))

  /** The ledger's answer alone, placing nothing; `admitMutationOperation` is the transaction. */
  evaluateMutationOperation = (args: AgentSessionMutationOperationAdmission) =>
    evaluateAgentSessionMutationOperation(this.state, args)

  /** Durable compare-and-swap for the right to run an admitted operation's effect: two replays both
   *  read `pending`, and only a conditional swap tells the one that may run from the one that must
   *  replay. */
  claimOperation = (args: Parameters<typeof claimAgentSessionOperationInto>[1]) =>
    this.transact((draft) => claimAgentSessionOperationInto(draft, args))

  /** Admission and, when `claimAfter` allows, the claim: one durable write before the effect. */
  admitAndClaimOperation = (
    args: Parameters<typeof admitAndClaimAgentSessionOperationInto>[1],
    claimAfter: ClaimAfterAdmission
  ) => this.transact((draft) => admitAndClaimAgentSessionOperationInto(draft, args, claimAfter))

  recordOperationOutcome = (
    args: Parameters<typeof settleAgentSessionOperationInto>[1]
  ): Promise<void> => this.transact((draft) => settleAgentSessionOperationInto(draft, args))

  /** Settlement committed with its journal write; a new submission also clears Sleep in that draft. */
  operationOutcomeReceipt = (args: Parameters<typeof agentSessionOperationOutcomeReceipt>[1]) =>
    agentSessionOperationOutcomeReceipt(this.transactions, args)

  /** Automatic queue admission uses the same record transition as a client's send receipt. */
  submissionReceipt = (sessionId: string) =>
    this.transactions.receipt(() => {}, { submissionSessionId: sessionId })

  admittedSendCount = (sessionId: string) => this.transactions.admittedSendCount(sessionId)

  commitOperationReceipt = (receipt: JournalOperationReceipt) =>
    this.transactions.commitReceipt(receipt)

  readCommandReceipt = (...args: Parameters<AgentSessionStoreTransactions['readCommandReceipt']>) =>
    this.transactions.readCommandReceipt(...args)

  replaceSessionOptions = (
    args: AgentSessionOptionsReplacement,
    assertMutationSupported?: () => void
  ): Promise<AgentSessionRecord> =>
    this.mutate(args.sessionId, (record) => {
      assertMutationSupported?.()
      return replaceAgentSessionRecordOptions(record, args)
    })

  /** One options revision from `agent-session-record-options`, decided against the record this
   *  ordered write holds. */
  reviseSessionOptions = <A extends { sessionId: string }>(
    revise: (record: AgentSessionRecord, args: A) => AgentSessionRecord,
    args: A
  ) => this.mutate(args.sessionId, (record) => revise(record, args))

  async retireClaimKey(keyId: string, now: number): Promise<void> {
    await this.transact((draft) => retireAgentSessionClaimKey(draft, keyId, now))
  }

  private mutate = async (
    sessionId: string,
    apply: (record: AgentSessionRecord) => AgentSessionRecord
  ): Promise<AgentSessionRecord> =>
    this.transact((draft) => mutateAgentSessionStoreRecord(draft, sessionId, apply))

  /** Told, once committed, of each session a transaction wrote a proof of death for — whichever
   *  transition wrote it, since every one lands here. Must not throw. */
  onDeathEvidence(listener: (sessionId: string) => void): () => void {
    this.deathEvidenceListeners.add(listener)
    return () => this.deathEvidenceListeners.delete(listener)
  }

  /** Told, once committed, when the store records its first chat. Must not throw. */
  onFirstRecord(listener: () => void): () => void {
    this.firstRecordListeners.add(listener)
    return () => this.firstRecordListeners.delete(listener)
  }

  /** Serializes every mutation. `apply` changes only the draft it is given; readers see the change
   *  once its rows have committed. */
  private transact = async <T>(
    apply: (draft: AgentSessionStoreState) => T,
    options?: { inMemoryWhenReadOnly?: boolean }
  ): Promise<T> => {
    return this.transactions.transactWithLifecycleNotifications(apply, {
      ...options,
      deathEvidenceListeners: this.deathEvidenceListeners,
      firstRecordListeners: this.firstRecordListeners
    })
  }
}
