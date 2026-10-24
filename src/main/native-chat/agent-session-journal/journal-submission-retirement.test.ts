import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { appendJournalHostCompound } from './journal-host-compound-writes'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { pinJournalEpoch } from './journal-epoch-pins'
import type { JournalRow } from './journal-row-schema'
import type { AgentSessionJournal } from './journal-store'

describe('compound submission retirement plans', () => {
  const tracked = createTrackedJournalOpener()
  let root: string
  let journal: AgentSessionJournal
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'retained target' }]
  }
  const input = {
    clientMessageId: 'target',
    payloadFingerprint: 'source-fingerprint',
    body,
    fence: 0
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-submission-retirement-'))
    journal = await tracked.open({
      stateDirectory: root,
      identity: {
        sessionId: 'target-session',
        workspaceId: 'workspace',
        hostId: 'host',
        agent: 'codex',
        providerHandle: codexProviderHandle('target-thread')
      }
    })
  })

  afterEach(async () => {
    await tracked.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  async function rejectTarget() {
    const submitted = await journal.appendSubmission(input)
    await journal.resolveDispatch({
      clientMessageId: input.clientMessageId,
      state: 'rejected',
      fence: 0,
      ...agentSessionFailureWords(
        agentSessionFailureFact('cancelled', { neverReachedAgent: true }),
        { surface: 'rejection' }
      )
    })
    return {
      epoch: submitted.epoch,
      sequence: submitted.sequence,
      payloadFingerprint: input.payloadFingerprint
    }
  }

  function retire(
    historical?: { epoch: string; sequence: number; payloadFingerprint: string },
    fence = 0
  ) {
    return appendJournalHostCompound(
      [journal],
      () => ({
        appends: [
          { journal, rows: journal.planRetireSubmission(input.clientMessageId, fence, historical) }
        ]
      }),
      { isCurrent: (candidate) => candidate === journal }
    )
  }

  it('retires only the rejected unlinked attempt with a receipt naming the actual tombstone', async () => {
    const historical = await rejectTarget()
    let selected: JournalRow | undefined
    await appendJournalHostCompound(
      [journal],
      () => ({
        appends: [
          { journal, rows: journal.planRetireSubmission(input.clientMessageId, 0, historical) }
        ],
        receiptRow: (prepared) => prepared[0]?.rows[0],
        receipt: {
          write: (_db, row) => {
            selected = row
          },
          committed: () => {}
        }
      }),
      { isCurrent: (candidate) => candidate === journal }
    )
    expect(selected).toMatchObject({
      kind: 'tombstone',
      retireSubmission: true,
      epoch: journal.epoch
    })
    expect(journal.submission(input.clientMessageId)).toBeUndefined()
  })

  it('refuses an outstanding attempt without appending any retirement row', async () => {
    await journal.appendSubmission(input)
    const before = journal.cursor()
    await expect(retire()).rejects.toThrow('only a rejected unlinked submission')
    expect(journal.cursor()).toEqual(before)
    expect(journal.submission(input.clientMessageId)?.dispatchState).toBe('pending')
  })

  it('requires an exact retained old-epoch submission before planning an absent attempt retirement', async () => {
    const historical = await rejectTarget()
    const database = openTestJournalHostDatabase(root)
    database.transaction((db) =>
      pinJournalEpoch(db, {
        ownerId: 'recovery-proof',
        sessionId: 'target-session',
        epoch: journal.epoch,
        endSequence: journal.cursor().sequence
      })
    )
    await journal.rollEpoch('handle_forked', 2)
    expect(journal.submission(input.clientMessageId)).toBeUndefined()
    const before = journal.cursor()
    await expect(retire(undefined, 2)).rejects.toThrow('only a rejected unlinked submission')
    await expect(
      retire({ ...historical, payloadFingerprint: 'different-body' }, 2)
    ).rejects.toThrow('historical identity changed')
    await expect(retire({ ...historical, sequence: historical.sequence + 1 }, 2)).rejects.toThrow(
      'historical identity changed'
    )
    expect(journal.cursor()).toEqual(before)
    const result = await retire(historical, 2)
    expect(result[0].rows[0]).toMatchObject({
      kind: 'tombstone',
      retireSubmission: true,
      fence: 2,
      epoch: journal.epoch
    })
    expect(journal.epoch).not.toBe(historical.epoch)
  })
})
