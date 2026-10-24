import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import {
  appendJournalHostCompound,
  type JournalHostCompoundPlan
} from './journal-host-compound-writes'
import {
  createTrackedJournalOpener,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from './journal-host-database-test-support'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalRow, JournalItemRow } from './journal-row-schema'
import {
  composeJournalOperationReceipts,
  type JournalOperationReceipt,
  type JournalRowTransactionHook
} from './journal-row-writer'
import type { AgentSessionJournal } from './journal-store'
import * as reducer from './journal-reducer'
import * as journalOpen from './journal-open'

describe('journal-owned host compound commits', () => {
  const tracked = createTrackedJournalOpener()
  const current = new Map<string, AgentSessionJournal>()
  let root: string
  let database: JournalHostDatabase

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-compound-'))
    database = openTestJournalHostDatabase(root)
    current.clear()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await tracked.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  async function open(sessionId: string, requiredInTransaction?: JournalRowTransactionHook) {
    const journal = await tracked.open({
      stateDirectory: root,
      identity: {
        sessionId,
        workspaceId: 'workspace',
        hostId: 'host',
        agent: 'codex',
        providerHandle: codexProviderHandle(`thread-${sessionId}`)
      },
      requiredInTransaction
    })
    current.set(sessionId, journal)
    return journal
  }

  const options = {
    isCurrent: (journal: AgentSessionJournal) => [...current.values()].includes(journal)
  }

  it('retires a real source card and publishes one unlinked target submission with its own sequence', async () => {
    const a = await open('a')
    const b = await open('b')
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'exact source body' }]
    }
    await a.queuedMessages.insert({ messageId: 'source-card', body })
    const fingerprint = agentSessionSendBodyFingerprint('a', body)
    const observations: boolean[] = []
    const observe = () => {
      observations.push(
        a.queuedMessages.get('source-card')?.state === 'withdrawn' &&
          b.submission('target-send')?.payloadFingerprint === fingerprint
      )
    }
    a.observeCommits(observe)
    b.observeCommits(observe)
    const send = () =>
      appendJournalHostCompound(
        [a, b],
        () => ({
          appends: [
            {
              journal: a,
              ...a.queuedMessages.plan([{ messageId: 'source-card', change: { op: 'withdrawn' } }])
            },
            {
              journal: b,
              ...b.planSubmission({
                clientMessageId: 'target-send',
                payloadFingerprint: fingerprint,
                body,
                fence: 0
              })
            }
          ]
        }),
        options
      )
    await send()
    expect(observations).toEqual([true, true])
    expect(b.submission('target-send')).not.toHaveProperty('queuedMessageId')
    const committed = [a.cursor(), b.cursor()]
    await expect(send()).rejects.toMatchObject({ code: 'journal_submission_exists' })
    expect([a.cursor(), b.cursor()]).toEqual(committed)
    expect(
      b.snapshot().submissions.filter((submission) => submission.clientMessageId === 'target-send')
    ).toHaveLength(1)
  })

  function row(journal: AgentSessionJournal, itemId: string, fence = 0) {
    return (seq: number, ts: number): JournalItemRow => ({
      v: 1,
      epoch: journal.epoch,
      seq,
      ts,
      fence,
      kind: 'item',
      itemId,
      revision: 1,
      body: { kind: 'status', text: itemId }
    })
  }

  function plan(
    a: AgentSessionJournal,
    b: AgentSessionJournal,
    receipt?: JournalOperationReceipt
  ): JournalHostCompoundPlan {
    return {
      appends: [
        { journal: a, rows: [row(a, 'source')] },
        { journal: b, rows: [row(b, 'target')] }
      ],
      receipt
    }
  }

  it('uses one FULL commit and each journal sequence, adopting all state before either observer', async () => {
    const a = await open('a')
    const b = await open('b')
    await b.appendQueueResume(0)
    const before = [a.cursor().sequence, b.cursor().sequence]
    let published = false
    const observations: boolean[] = []
    const observe = () =>
      observations.push(a.itemBody('source') !== null && b.itemBody('target') !== null && published)
    a.observeCommits(observe)
    b.observeCommits(observe)
    const transactions = vi.spyOn(database, 'transaction')
    const result = appendJournalHostCompound(
      [b, a],
      () =>
        plan(a, b, {
          write: (db) => {
            expect(db.isTransaction).toBe(true)
          },
          committed: () => {
            published = true
          }
        }),
      options
    )
    expect(observations).toEqual([true, true])
    const rows = await result
    expect(rows.map(({ journal }) => journal)).toEqual([a, b])
    expect(rows.map(({ rows }) => rows[0].seq)).toEqual(before.map((seq) => seq + 1))
    expect(transactions).toHaveBeenCalledTimes(1)
    expect(transactions.mock.calls[0][1]).not.toBe(true)
  })

  it.each([
    'first insert',
    'second insert',
    'metadata receipt',
    'shared receipt',
    'required proof'
  ] as const)('rolls both journals and receipts back after %s failure', async (failure) => {
    let failProof = false
    const a = await open('a')
    const b = await open('b', () => {
      if (failProof) {
        throw new Error('required proof')
      }
    })
    const before = [a.cursor(), b.cursor()]
    database.db.exec('CREATE TABLE compound_receipts (id TEXT PRIMARY KEY)')
    if (failure === 'first insert' || failure === 'second insert') {
      database.db.exec(
        `CREATE TRIGGER fail_compound BEFORE INSERT ON journal_rows WHEN NEW.session_id='${failure === 'first insert' ? 'a' : 'b'}' BEGIN SELECT RAISE(ABORT, 'insertion failed'); END`
      )
    }
    failProof = failure === 'required proof'
    let adopted = false
    let invalidated = 0
    const receipt: JournalOperationReceipt = {
      write: (db) => {
        db.prepare('INSERT INTO compound_receipts VALUES (?)').run('op')
        if (failure.endsWith('receipt')) {
          throw new Error(failure)
        }
      },
      committed: () => {
        adopted = true
      },
      rolledBack: () => {
        invalidated++
      }
    }
    await expect(
      appendJournalHostCompound(
        [a, b],
        () => {
          const planned = plan(a, b, failure === 'metadata receipt' ? undefined : receipt)
          if (failure === 'metadata receipt') {
            planned.appends = [{ ...planned.appends[0], receipt }, planned.appends[1]]
          }
          return planned
        },
        options
      )
    ).rejects.toThrow()
    expect([a.cursor(), b.cursor()]).toEqual(before)
    expect(liveTestJournalRows(database.db, 'a')).toHaveLength(before[0].sequence)
    expect(liveTestJournalRows(database.db, 'b')).toHaveLength(before[1].sequence)
    expect(database.db.prepare('SELECT id FROM compound_receipts').all()).toEqual([])
    expect(adopted).toBe(false)
    expect(invalidated).toBe(1)
  })

  it.each(['epoch', 'tail', 'fence'] as const)(
    'rejects a durable %s mismatch before either insert',
    async (mismatch) => {
      const a = await open('a')
      const b = await open('b')
      const before = a.cursor()
      if (mismatch === 'epoch') {
        publishTestJournalEpoch(database.db, 'b', 'superseding-epoch')
      } else if (mismatch === 'tail') {
        database.db.prepare('DELETE FROM journal_rows WHERE session_id=?').run('b')
      } else {
        database.db
          .prepare(
            "UPDATE journal_rows SET row_json=json_set(row_json,'$.fence',9) WHERE session_id=?"
          )
          .run('b')
      }
      await expect(appendJournalHostCompound([a, b], () => plan(a, b), options)).rejects.toThrow()
      expect(a.cursor()).toEqual(before)
      expect(a.itemBody('source')).toBeNull()
      expect(liveTestJournalRows(database.db, 'a')).toHaveLength(before.sequence)
    }
  )

  it('checks current host handles again inside the transaction', async () => {
    const a = await open('a')
    const b = await open('b')
    await expect(
      appendJournalHostCompound(
        [a, b],
        () => {
          current.delete('b')
          return plan(a, b)
        },
        options
      )
    ).rejects.toThrow('no longer the host owner')
    expect(a.itemBody('source')).toBeNull()
    expect(b.itemBody('target')).toBeNull()
  })

  it('rechecks a waiting no-op owner before planning from its stale fold', async () => {
    const a = await open('a')
    const b = await open('b')
    let pending: Promise<unknown> = Promise.resolve()
    let planned = false
    a.observeCommits(() => {
      pending = appendJournalHostCompound(
        [a, b],
        () => {
          planned = true
          return { appends: [] }
        },
        options
      )
      current.delete('a')
    })
    await a.appendQueueResume(0)
    await expect(pending).rejects.toThrow('no longer the host owner')
    expect(planned).toBe(false)
  })

  it('invalidates every composed receipt after rollback even when an earlier invalidation throws', async () => {
    const a = await open('a')
    const b = await open('b')
    const invalidated: string[] = []
    const receipt = composeJournalOperationReceipts(
      {
        write: () => {},
        committed: () => {},
        rolledBack: () => {
          invalidated.push('first')
          throw new Error('cache invalidation failed')
        }
      },
      {
        write: () => {},
        committed: () => {},
        rolledBack: () => {
          invalidated.push('second')
        }
      }
    )
    await expect(
      appendJournalHostCompound(
        [a, b],
        () => ({
          ...plan(a, b),
          receipt: composeJournalOperationReceipts(receipt, {
            write: () => {
              throw new Error('original transaction error')
            },
            committed: () => {}
          })
        }),
        options
      )
    ).rejects.toThrow('original transaction error')
    expect(invalidated).toEqual(['first', 'second'])
    expect(a.itemBody('source')).toBeNull()
    expect(b.itemBody('target')).toBeNull()
    await expect(a.appendQueueResume(0)).rejects.toMatchObject({ code: 'journal_closed' })
    await expect(b.appendQueueResume(0)).rejects.toMatchObject({ code: 'journal_closed' })
  })

  it('drains a ticket admitted before close before reopening either journal', async () => {
    const a = await open('a')
    const b = await open('b')
    let admitted: Promise<unknown> = Promise.resolve()
    a.observeCommits(() => {
      a.observeCommits(() => {})
      admitted = appendJournalHostCompound([a, b], () => plan(a, b), options)
    })
    const outer = a.appendQueueResume(0)
    const closing = Promise.all([a.close(), b.close()])
    await Promise.all([outer, admitted, closing])
    const before = [a.cursor(), b.cursor()]
    const replayed = await Promise.all([open('a'), open('b')])
    expect(replayed.map((journal) => journal.cursor())).toEqual(before)
    expect(replayed[0].itemBody('source')).not.toBeNull()
    expect(replayed[1].itemBody('target')).not.toBeNull()
  })

  it('rejects different host database identities before invoking the planner', async () => {
    const a = await open('a')
    const foreign = await tracked.open({
      stateDirectory: join(root, 'other-host'),
      identity: {
        sessionId: 'foreign',
        workspaceId: 'workspace',
        hostId: 'other-host',
        agent: 'codex',
        providerHandle: codexProviderHandle('foreign-thread')
      }
    })
    current.set('foreign', foreign)
    let planned = false
    await expect(
      appendJournalHostCompound(
        [a, foreign],
        () => {
          planned = true
          return plan(a, foreign)
        },
        options
      )
    ).rejects.toThrow('identical owned host database')
    expect(planned).toBe(false)
  })

  it('commits receipt-only participant work before notifying either view', async () => {
    const a = await open('a')
    const b = await open('b')
    let legacyAdopted = false
    let storeAdopted = false
    const observed: boolean[] = []
    a.observeCommits(() => {
      observed.push(legacyAdopted && storeAdopted)
    })
    const before = [a.cursor(), b.cursor()]
    const result = await appendJournalHostCompound(
      [a, b],
      () => ({
        appends: [
          {
            journal: a,
            rows: [],
            receipt: {
              write: (db) => {
                db.exec('CREATE TABLE receipt_only (id TEXT)')
              },
              committed: () => {
                legacyAdopted = true
              }
            }
          },
          { journal: b, rows: [] }
        ],
        receipt: {
          write: (db) => {
            db.prepare('INSERT INTO receipt_only VALUES (?)').run('committed')
          },
          committed: () => {
            storeAdopted = true
          }
        }
      }),
      options
    )
    expect(result.map(({ rows }) => rows)).toEqual([[], []])
    expect([a.cursor(), b.cursor()]).toEqual(before)
    expect(observed).toEqual([true])
    expect(database.db.prepare('SELECT id FROM receipt_only').get()?.id).toBe('committed')
  })

  it('rejects duplicate, foreign and same-session alias appends without publishing', async () => {
    const a = await open('a')
    const b = await open('b')
    const c = await open('c')
    await expect(
      appendJournalHostCompound(
        [a, b],
        () => ({ appends: [...plan(a, b).appends, ...plan(a, b).appends] }),
        options
      )
    ).rejects.toThrow()
    await expect(appendJournalHostCompound([a, b], () => plan(a, c), options)).rejects.toThrow()
    const alias = await open('a')
    await expect(
      appendJournalHostCompound([a, alias], () => plan(a, alias), { isCurrent: () => true })
    ).rejects.toThrow()
    expect(a.itemBody('source')).toBeNull()
    expect(b.itemBody('target')).toBeNull()
  })

  it('selects the shared receipt row from prepared rows rather than guessed sequences', async () => {
    const a = await open('a')
    const b = await open('b')
    let selected: JournalRow | undefined
    const result = await appendJournalHostCompound(
      [a, b],
      () => ({
        ...plan(a, b, {
          write: (_db, row) => {
            selected = row
          },
          committed: () => {}
        }),
        receiptRow: (prepared) => prepared.find(({ journal }) => journal === b)?.rows[0]
      }),
      options
    )
    expect(selected).toEqual(result[1].rows[0])
  })

  it('accepts a lower-fenced batch tail while retaining the highest admission fence, live and after replay', async () => {
    let a = await open('a')
    const b = await open('b')
    await appendJournalHostCompound(
      [a, b],
      () => ({
        appends: [
          {
            journal: a,
            rows: [row(a, 'advanced-boundary', 5), row(a, 'generationless-tail', 0)]
          }
        ]
      }),
      options
    )
    const after = () =>
      appendJournalHostCompound(
        [a, b],
        () => ({
          appends: [
            { journal: a, rows: [row(a, 'after-boundary', 5), row(a, 'same-generation-tail', 5)] },
            { journal: b, rows: [row(b, 'target')] }
          ]
        }),
        options
      )
    await after()
    await appendJournalHostCompound(
      [a, b],
      () => ({
        appends: [
          {
            journal: a,
            rows: [row(a, 'later-boundary', 8), row(a, 'later-generationless-tail', 5)]
          }
        ]
      }),
      options
    )
    await a.close()
    a = await open('a')
    await appendJournalHostCompound(
      [a, b],
      () => ({ appends: [{ journal: a, rows: [row(a, 'after-replay', 8)] }] }),
      options
    )
    expect(a.itemBody('after-replay')).not.toBeNull()
    await expect(
      appendJournalHostCompound(
        [a, b],
        () => ({ appends: [{ journal: a, rows: [row(a, 'stale', 7)] }] }),
        options
      )
    ).rejects.toMatchObject({ code: 'journal_stale_fence' })
    expect(a.itemBody('stale')).toBeNull()
  })

  it('replays an older cached fold missing its derived tail fence instead of substituting the maximum', async () => {
    let a = await open('a')
    const b = await open('b')
    await appendJournalHostCompound(
      [a, b],
      () => ({ appends: [{ journal: a, rows: [row(a, 'high', 5), row(a, 'low', 0)] }] }),
      options
    )
    await a.close()
    const replay = journalOpen.replayJournal
    vi.spyOn(journalOpen, 'replayJournal').mockImplementationOnce((db, sessionId) => {
      const cached = replay(db, sessionId)
      if (!cached) {
        throw new Error('fixture requires a durable journal')
      }
      Reflect.deleteProperty(cached.state, 'lastRowFence')
      return cached
    })
    a = await open('a')
    await appendJournalHostCompound(
      [a, b],
      () => ({ appends: [{ journal: a, rows: [row(a, 'after-old-cache', 5)] }] }),
      options
    )
    expect(a.itemBody('after-old-cache')).not.toBeNull()
  })

  it('does not report observer-only failure as rollback or poison the adopted journals', async () => {
    const a = await open('a')
    const b = await open('b')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    a.observeCommits(() => {
      throw new Error('observer failed')
    })
    let bObserved = false
    b.observeCommits(() => {
      bObserved = true
    })
    await expect(
      appendJournalHostCompound([a, b], () => plan(a, b), options)
    ).resolves.toHaveLength(2)
    expect(bObserved).toBe(true)
    await a.appendQueueResume(0)
    expect(a.itemBody('source')).not.toBeNull()
  })

  it('rejects an asynchronous inner submission receipt and rolls its row back', async () => {
    const a = await open('a')
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'must stay synchronous' }]
    }
    const before = a.cursor()
    await expect(
      a.appendSubmission(
        {
          clientMessageId: 'async-receipt',
          payloadFingerprint: agentSessionSendBodyFingerprint('a', body),
          body,
          fence: 0
        },
        undefined,
        { write: async () => undefined, committed: () => {} }
      )
    ).rejects.toThrow('must not await')
    expect(a.cursor()).toEqual(before)
    expect(liveTestJournalRows(database.db, 'a')).toHaveLength(before.sequence)
    expect(a.submission('async-receipt')).toBeUndefined()
  })

  it('never notifies a half-adopted fold and fences both lanes until replay', async () => {
    const a = await open('a')
    const b = await open('b')
    const apply = reducer.applyJournalRow
    const injected = vi
      .spyOn(reducer, 'applyJournalRow')
      .mockImplementation((state, row, savedAt) => {
        if (row.kind === 'item' && row.itemId === 'target') {
          throw new Error('second fold failed')
        }
        apply(state, row, savedAt)
      })
    let notified = false
    a.observeCommits(() => {
      notified = true
    })
    b.observeCommits(() => {
      notified = true
    })
    await expect(
      appendJournalHostCompound([a, b], () => plan(a, b), options)
    ).rejects.toMatchObject({ committed: true })
    expect(a.itemBody('source')).not.toBeNull()
    expect(b.itemBody('target')).toBeNull()
    expect(notified).toBe(false)
    await expect(a.appendQueueResume(0)).rejects.toMatchObject({ code: 'journal_closed' })
    await expect(b.appendQueueResume(0)).rejects.toMatchObject({ code: 'journal_closed' })
    injected.mockRestore()
    await Promise.all([a.close(), b.close()])
    const replayed = await Promise.all([open('a'), open('b')])
    expect(replayed[0].itemBody('source')).not.toBeNull()
    expect(replayed[1].itemBody('target')).not.toBeNull()
  })

  it.each(['roll', 'replace'] as const)(
    'contains a %s observer failure after full adoption before the next compound',
    async (kind) => {
      const a = await open('a')
      const b = await open('b')
      const oldEpoch = a.epoch
      let storeAdopted = kind === 'roll'
      const observed: boolean[] = []
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      a.observeCommits(() => {
        observed.push(storeAdopted && a.epoch !== oldEpoch)
        throw new Error('epoch observer failed')
      })
      await (kind === 'roll'
        ? a.rollEpoch('handle_forked', 0)
        : a.replaceEpochItems('handle_forked', 0, [], () => ({
            write: () => {},
            committed: () => {
              storeAdopted = true
            }
          })))
      expect(observed).toEqual([true])
      await appendJournalHostCompound([a, b], () => plan(a, b), options)
      expect(a.itemBody('source')).not.toBeNull()
      expect(b.itemBody('target')).not.toBeNull()
    }
  )

  it('blocks a compound already admitted from a failed durable epoch adoption', async () => {
    const a = await open('a')
    const b = await open('b')
    const oldEpoch = a.epoch
    let pending: Promise<unknown> = Promise.resolve()
    let planned = false
    const replacement = a.replaceEpochItems('handle_forked', 0, [], () => ({
      write: () => {},
      committed: () => {
        pending = appendJournalHostCompound(
          [a, b],
          () => {
            planned = true
            return plan(a, b)
          },
          options
        )
        throw new Error('epoch receipt adoption failed')
      }
    }))
    await expect(replacement).rejects.toMatchObject({ committed: true })
    await expect(pending).rejects.toMatchObject({ code: 'journal_closed' })
    expect(planned).toBe(false)
    await a.close()
    const replayed = await open('a')
    expect(replayed.epoch).not.toBe(oldEpoch)
    await appendJournalHostCompound([replayed, b], () => plan(replayed, b), options)
    expect(replayed.itemBody('source')).not.toBeNull()
  })

  it('poisons already-admitted callbacks after COMMIT adoption failure and recovers by replay', async () => {
    const a = await open('a')
    const b = await open('b')
    let queuedA: Promise<unknown> = Promise.resolve()
    let queuedB: Promise<unknown> = Promise.resolve()
    const before = [a.cursor().sequence, b.cursor().sequence]
    const failed = appendJournalHostCompound(
      [a, b],
      () => {
        queuedA = a.appendQueueResume(0)
        queuedB = b.appendQueueResume(0)
        return plan(a, b, {
          write: () => {},
          committed: () => {
            throw new Error('adoption failed after commit')
          }
        })
      },
      options
    )
    await expect(failed).rejects.toMatchObject({ committed: true })
    await expect(queuedA).rejects.toMatchObject({ code: 'journal_closed' })
    await expect(queuedB).rejects.toMatchObject({ code: 'journal_closed' })
    expect(liveTestJournalRows(database.db, 'a')).toHaveLength(before[0] + 1)
    expect(liveTestJournalRows(database.db, 'b')).toHaveLength(before[1] + 1)
    await Promise.all([a.close(), b.close()])
    const reopenedA = await open('a')
    const reopenedB = await open('b')
    expect(reopenedA.itemBody('source')).not.toBeNull()
    expect(reopenedB.itemBody('target')).not.toBeNull()
    await reopenedA.appendQueueResume(0)
    expect(reopenedA.cursor().sequence).toBe(before[0] + 2)
  })
})
