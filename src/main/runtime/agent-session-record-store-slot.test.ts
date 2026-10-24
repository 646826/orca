/**
 * The record store opened on its own, for launch admission, and the chat host built on it later.
 * The store is a single writer, so the property that matters is that there is only ever one.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { openAgentSessionRecordStoreOnce } from './agent-session-record-store-slot'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  acquireProfileStateRuntimeAdmission,
  type ProfileStateRuntimeAdmission
} from '../persistence/profile-state/profile-state-access'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

const HOST_ID = 'local'
let stateDirectory: string
let admission: ProfileStateRuntimeAdmission

function location(directory = stateDirectory) {
  return {
    stateDirectory: directory,
    hostId: HOST_ID,
    logger: createStructuredAgentSessionLogger()
  }
}

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'orca-record-store-slot-'))
  admission = acquireProfileStateRuntimeAdmission(stateDirectory)
})

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  admission.release()
  vi.restoreAllMocks()
  await rm(stateDirectory, { recursive: true, force: true })
})

describe('the record store slot', () => {
  it('fences an empty slot for the entire stop', async () => {
    let entered: () => void = () => {}
    let release: () => void = () => {}
    const enteredFlush = new Promise<void>((resolve) => {
      entered = resolve
    })
    const flush = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(agentModelCatalogStore, 'flushPersistence').mockImplementationOnce(() => {
      entered()
      return flush
    })
    const stopping = stopStructuredAgentSessionRuntime()
    try {
      await expect(openAgentSessionRecordStoreOnce(location())).rejects.toThrow(
        'agent_session_record_store_stopping'
      )
      await enteredFlush
      await expect(openAgentSessionRecordStoreOnce(location())).rejects.toThrow(
        'agent_session_record_store_stopping'
      )
    } finally {
      release()
      await stopping
    }
    await expect(openAgentSessionRecordStoreOnce(location())).resolves.toHaveProperty('store')
  })

  it('keeps admission stopped after the database closed but final runtime cleanup failed', async () => {
    const opened = await openAgentSessionRecordStoreOnce(location())
    vi.spyOn(agentModelCatalogStore, 'flushPersistence').mockRejectedValueOnce(
      new Error('catalog flush failed')
    )
    await expect(stopStructuredAgentSessionRuntime()).rejects.toThrow('catalog flush failed')
    expect(opened.journalDatabase.isClosed).toBe(true)
    await expect(openAgentSessionRecordStoreOnce(location())).rejects.toThrow(
      'agent_session_record_store_stopping'
    )
    await stopStructuredAgentSessionRuntime()
    await expect(openAgentSessionRecordStoreOnce(location())).resolves.toHaveProperty('store')
  })

  it('retains partial initialization when cleanup close fails instead of admitting another writer', async () => {
    vi.spyOn(AgentSessionRecordStore, 'open').mockImplementationOnce(() => {
      throw new Error('store initialization failed')
    })
    const close = vi.spyOn(JournalHostDatabase.prototype, 'close').mockImplementationOnce(() => {
      throw new Error('initial cleanup failed')
    })
    const failed = await openAgentSessionRecordStoreOnce(location()).catch(
      (error: unknown) => error
    )
    expect(failed).toBeInstanceOf(AggregateError)
    if (!(failed instanceof AggregateError)) {
      throw new Error('Expected initialization and cleanup errors')
    }
    expect(failed.errors.map((error: Error) => error.message)).toEqual([
      'store initialization failed',
      'initial cleanup failed'
    ])
    await expect(openAgentSessionRecordStoreOnce(location())).rejects.toThrow(
      'agent_session_record_store_stopping'
    )
    expect(close).toHaveBeenCalledOnce()
    await stopStructuredAgentSessionRuntime()
    expect(close).toHaveBeenCalledTimes(2)
    await expect(openAgentSessionRecordStoreOnce(location())).resolves.toHaveProperty('store')
  })

  it('retains an installed host owner after close failure and prevents a replacement until retry', async () => {
    const opened = await openAgentSessionRecordStoreOnce(location())
    const deps = {
      ...location(),
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => stateDirectory,
      resolveClaudeAuthPolicy: () => ({ account: 'managed' as const }),
      resolveEnvironment: async () => ({}),
      resolveLaunchArgs: () => []
    }
    await ensureStructuredAgentSessionHost(deps)
    vi.spyOn(opened.journalDatabase, 'close').mockImplementationOnce(() => {
      throw new Error('host close blocked')
    })
    await expect(stopStructuredAgentSessionRuntime()).rejects.toThrow('host close blocked')
    await expect(ensureStructuredAgentSessionHost(deps)).rejects.toThrow(
      'agent_session_record_store_stopping'
    )
    expect(opened.journalDatabase.isClosed).toBe(false)
    await stopStructuredAgentSessionRuntime()
    expect(opened.journalDatabase.isClosed).toBe(true)
  })

  it('drains a previously admitted installation without publishing it after stop', async () => {
    const opened = await openAgentSessionRecordStoreOnce(location())
    let entered: () => void = () => {}
    let release: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const backfill = opened.store.backfillChatPermissionModes
    vi.spyOn(opened.store, 'backfillChatPermissionModes').mockImplementation(async (read) => {
      await backfill(read)
      entered()
      await gate
    })
    const deps = {
      ...location(),
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => stateDirectory,
      resolveClaudeAuthPolicy: () => ({ account: 'managed' as const }),
      resolveEnvironment: async () => ({}),
      resolveLaunchArgs: () => [],
      resolveAgentFullAccess: () => false
    }
    const installing = ensureStructuredAgentSessionHost(deps)
    await started
    const stopping = stopStructuredAgentSessionRuntime()
    try {
      await expect(ensureStructuredAgentSessionHost(deps)).rejects.toThrow(
        'agent_session_record_store_stopping'
      )
      expect(opened.journalDatabase.isClosed).toBe(false)
    } finally {
      release()
      await installing
      await stopping
    }
    expect(getStructuredAgentSessionHost()).toBeNull()
    expect(opened.journalDatabase.isClosed).toBe(true)
  })

  it('fences old endpoints immediately and after a successful stop and reopen', async () => {
    const opened = await openAgentSessionRecordStoreOnce(location())
    const identity = {
      callerKey: 'caller',
      operationId: `${Date.now()}-000000000000000000000000000000aa`
    }
    const stopping = stopStructuredAgentSessionRuntime()
    await expect(opened.launchLedger.publicationEligibility(identity)).rejects.toThrow(
      'agent_launch_ledger_stopped'
    )
    await stopping
    const next = await openAgentSessionRecordStoreOnce(location())
    await expect(next.launchLedger.publicationEligibility(identity)).resolves.toBe('unrecorded')
    await expect(opened.launchLedger.fail({ ...identity, code: 'failed' })).rejects.toThrow(
      'agent_launch_ledger_stopped'
    )
  })

  it('joins concurrent stops while an accepted ledger command is draining', async () => {
    const opened = await openAgentSessionRecordStoreOnce(location())
    const now = Date.now()
    const args = {
      callerKey: 'caller',
      operationId: `${now}-000000000000000000000000000000aa`,
      fingerprint: 'fp',
      now
    }
    await opened.launchLedger.admit(args)
    let release: () => void = () => {}
    const ack = new Promise<void>((resolve) => {
      release = resolve
    })
    const record = opened.store.recordOperationOutcome
    vi.spyOn(opened.store, 'recordOperationOutcome').mockImplementation(async (input) => {
      await record(input)
      await ack
    })
    const pending = opened.launchLedger.fail({ ...args, code: 'failed' })
    const first = stopStructuredAgentSessionRuntime()
    const second = stopStructuredAgentSessionRuntime()
    await expect(openAgentSessionRecordStoreOnce(location())).rejects.toThrow(
      'agent_session_record_store_stopping'
    )
    expect(opened.journalDatabase.isClosed).toBe(false)
    release()
    await pending
    await Promise.all([first, second])
    expect(opened.journalDatabase.isClosed).toBe(true)
  })

  it('retains a stopped standalone owner when database close fails and retries that exact owner', async () => {
    const opened = await openAgentSessionRecordStoreOnce(location())
    const close = vi.spyOn(opened.journalDatabase, 'close').mockImplementationOnce(() => {
      throw new Error('close blocked')
    })
    await expect(stopStructuredAgentSessionRuntime()).rejects.toThrow('close blocked')
    await expect(openAgentSessionRecordStoreOnce(location())).rejects.toThrow(
      'agent_session_record_store_stopping'
    )
    expect(opened.journalDatabase.isClosed).toBe(false)
    await stopStructuredAgentSessionRuntime()
    expect(close).toHaveBeenCalledTimes(2)
    expect(opened.journalDatabase.isClosed).toBe(true)
    const reopened = await openAgentSessionRecordStoreOnce(location())
    expect(reopened.store).not.toBe(opened.store)
  })

  it('does not hand an opening owner to a caller after stop has begun', async () => {
    const opening = openAgentSessionRecordStoreOnce(location())
    const stopped = stopStructuredAgentSessionRuntime()
    await expect(opening).rejects.toThrow('agent_session_record_store_stopping')
    await stopped
    await expect(openAgentSessionRecordStoreOnce(location())).resolves.toHaveProperty('store')
  })

  it('hands every caller the same store', async () => {
    const [first, second] = await Promise.all([
      openAgentSessionRecordStoreOnce(location()),
      openAgentSessionRecordStoreOnce(location())
    ])

    expect(second.store).toBe(first.store)
    expect(second.conversationDeliveryBinding).toBe(first.conversationDeliveryBinding)
    expect(
      first.conversationDeliveryBinding.persistence.conversationDeliveryEvidence(
        first.journalDatabase.db,
        'uninstalled'
      )
    ).toBeNull()
    expect(() =>
      first.conversationDeliveryBinding.persistence.conversationDeliveryCommit(
        first.journalDatabase.db,
        'manifest',
        'receipt'
      )
    ).toThrow('unavailable')
  })

  it('builds a chat host installed after admission on the store admission opened', async () => {
    const { store } = await openAgentSessionRecordStoreOnce(location())
    const close = vi.spyOn(JournalHostDatabase.prototype, 'close')

    const host = await ensureStructuredAgentSessionHost({
      ...location(),
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => stateDirectory,
      resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
      resolveEnvironment: async () => ({}),
      resolveLaunchArgs: () => []
    })
    expect(host.deps.store).toBe(store)

    await stopStructuredAgentSessionRuntime()
    // The host's teardown closes the one connection; stop does not close it a second time.
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes a store no chat host was built on when the runtime stops', async () => {
    const { store } = await openAgentSessionRecordStoreOnce(location())
    const close = vi.spyOn(JournalHostDatabase.prototype, 'close')

    await stopStructuredAgentSessionRuntime()

    expect(close).toHaveBeenCalledOnce()
    const reopened = await openAgentSessionRecordStoreOnce(location())
    expect(reopened.store).not.toBe(store)
  })

  it('refuses a second profile rather than opening a second store', async () => {
    await openAgentSessionRecordStoreOnce(location())
    const elsewhere = await mkdtemp(join(tmpdir(), 'orca-record-store-slot-other-'))
    try {
      await expect(openAgentSessionRecordStoreOnce(location(elsewhere))).rejects.toThrow(
        'agent_session_record_store_location_changed'
      )
    } finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('lets the next caller retry after an open fails', async () => {
    const notADirectory = join(stateDirectory, 'profile-file')
    await writeFile(notADirectory, 'not a profile')

    await expect(openAgentSessionRecordStoreOnce(location(notADirectory))).rejects.toThrow()
    await expect(openAgentSessionRecordStoreOnce(location())).resolves.toMatchObject({
      store: expect.anything()
    })
  })
})
