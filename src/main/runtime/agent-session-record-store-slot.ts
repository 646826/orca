import {
  createStructuredConversationRuntimeBinding,
  type StructuredConversationRuntimeBinding
} from './structured-conversation-runtime-binding'
// The process's one durable agent-session record store, opened on its own.
//
// The launch ledger lives in this store, and admitting a launch is the first thing every replay-safe
// `agent.launch` does — a terminal launch included. Reaching the store used to mean installing the
// whole chat host (provider adapters, the host, the model catalog) first. The store is opened here
// instead and the chat host, when something needs it, is built on this same instance: the store is
// a single writer, so a second copy of it would diverge.
//
// A stopped owner remains here until its database closes successfully, including failed teardown.

import { AgentSessionRecordStore } from './agent-session-record-store'
import { AgentLaunchLedgerOwner, type AgentLaunchLedgerIdentity } from './agent-launch-ledger'
import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { openStructuredAgentSessionJournalDatabase } from './structured-agent-session-journal-open'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

export type AgentSessionRecordStoreLocation = {
  stateDirectory: string
  hostId: string
  logger: StructuredAgentSessionLogger
}

export type OpenedAgentSessionRecordStore = {
  launchLedger: AgentLaunchLedgerOwner
  journalDatabase: JournalHostDatabase
  conversationDeliveryBinding: StructuredConversationRuntimeBinding
  store: AgentSessionRecordStore
}

type RecordStoreSlot = {
  cleanup: RecordStoreOpenCleanup
  stopping: boolean
  launchLedger?: AgentLaunchLedgerOwner
  stateDirectory: string
  opened: Promise<OpenedAgentSessionRecordStore>
  /** Set once `opened` resolves, so a reader that must not wait can ask without awaiting. */
  store?: AgentSessionRecordStore
}

let opening: RecordStoreSlot | null = null
let stopping = false

type RecordStoreOpenCleanup = {
  failed?: {
    journalDatabase: JournalHostDatabase
    conversationDeliveryBinding: StructuredConversationRuntimeBinding
    errors: unknown[]
  }
}

export function openAgentSessionRecordStoreOnce(
  location: AgentSessionRecordStoreLocation
): Promise<OpenedAgentSessionRecordStore> {
  if (stopping) {
    return Promise.reject(new Error('agent_session_record_store_stopping'))
  }
  if (opening) {
    // Loud rather than a silent second store: one process serves one profile.
    if (opening.stateDirectory !== location.stateDirectory) {
      return Promise.reject(new Error('agent_session_record_store_location_changed'))
    }
    return admittedOpened(opening)
  }
  const cleanup: RecordStoreOpenCleanup = {}
  const slot: RecordStoreSlot = {
    cleanup,
    stopping: false,
    stateDirectory: location.stateDirectory,
    opened: openRecordStore(location, cleanup).then(
      (opened) => {
        slot.store = opened.store
        slot.launchLedger = opened.launchLedger
        return opened
      },
      (error: unknown) => {
        if (cleanup.failed) {
          slot.stopping = true
        }
        // A failed open must not poison the slot: the next caller retries.
        if (opening === slot && !slot.stopping) {
          opening = null
        }
        throw error
      }
    )
  }
  opening = slot
  return admittedOpened(slot)
}

function admittedOpened(slot: RecordStoreSlot): Promise<OpenedAgentSessionRecordStore> {
  if (slot.stopping) {
    return Promise.reject(new Error('agent_session_record_store_stopping'))
  }
  return slot.opened.then((opened) => {
    if (slot.stopping || opening !== slot) {
      throw new Error('agent_session_record_store_stopping')
    }
    return opened
  })
}

export async function readAgentLaunchPublicationEligibility(
  input: AgentLaunchLedgerIdentity
): Promise<'recorded' | 'unrecorded' | 'unknown'> {
  const slot = opening
  if (!slot || slot.stopping) {
    return 'unknown'
  }
  try {
    const identity = structuredClone(input)
    const opened = await admittedOpened(slot)
    const eligibility = await opened.launchLedger.publicationEligibility(identity)
    return slot.stopping || opening !== slot ? 'unknown' : eligibility
  } catch {
    return 'unknown'
  }
}

/** The store when it is already open; null while it opens or before anything asked for it. */
export function peekOpenedAgentSessionRecordStore(): AgentSessionRecordStore | null {
  return opening?.store ?? null
}

async function openRecordStore(
  location: AgentSessionRecordStoreLocation,
  cleanup: RecordStoreOpenCleanup
): Promise<OpenedAgentSessionRecordStore> {
  const journalDatabase = openStructuredAgentSessionJournalDatabase(location)
  const conversationDeliveryBinding = createStructuredConversationRuntimeBinding(journalDatabase)
  try {
    const store = AgentSessionRecordStore.open({
      journalDatabase,
      hostId: location.hostId,
      ...conversationDeliveryBinding.persistence
    })
    return {
      journalDatabase,
      conversationDeliveryBinding,
      store,
      launchLedger: new AgentLaunchLedgerOwner(store)
    }
  } catch (error) {
    cleanup.failed = { journalDatabase, conversationDeliveryBinding, errors: [error] }
    closeFailedRecordStoreOpen(cleanup)
    throw error
  }
}

function closeFailedRecordStoreOpen(cleanup: RecordStoreOpenCleanup): void {
  const failed = cleanup.failed
  if (!failed) {
    return
  }
  try {
    failed.journalDatabase.close()
    failed.conversationDeliveryBinding.close()
    cleanup.failed = undefined
  } catch (error) {
    failed.errors.push(error)
    throw new AggregateError(
      failed.errors,
      'agent session record store initialization cleanup failed'
    )
  }
}

/** Stop public admission before any wait, retaining the owner until its database is closed. */
export async function releaseAgentSessionRecordStore(): Promise<OpenedAgentSessionRecordStore | null> {
  stopping = true
  const released = opening
  if (!released) {
    return null
  }
  released.stopping = true
  const draining = released.launchLedger?.stopAndDrain()
  const opened = await released.opened.catch(() => null)
  if (!opened) {
    closeFailedRecordStoreOpen(released.cleanup)
    if (opening === released) {
      opening = null
    }
    return null
  }
  await (draining ?? opened.launchLedger.stopAndDrain())
  return opened
}

/** Lift the fence only after the complete runtime stop, including its final persistence flush. */
export function completeAgentSessionRecordStoreStop(): void {
  if (opening) {
    throw new Error('agent_session_record_store_release_unproven')
  }
  stopping = false
}

export function finishAgentSessionRecordStoreRelease(opened: OpenedAgentSessionRecordStore): void {
  if (!opening?.stopping || opening.store !== opened.store || !opened.journalDatabase.isClosed) {
    throw new Error('agent_session_record_store_release_unproven')
  }
  opened.conversationDeliveryBinding.close()
  opening = null
}
