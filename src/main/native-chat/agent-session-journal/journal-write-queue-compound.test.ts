import { describe, expect, it } from 'vitest'
import { JournalWriteQueue } from './journal-write-queue'

describe('shared journal lane tickets', () => {
  it('rejects an asynchronous compound body rather than treating it as an owned write', async () => {
    const a = new JournalWriteQueue('a')
    const b = new JournalWriteQueue('b')
    await expect(
      // @ts-expect-error a compound body cannot retain lanes across an await
      JournalWriteQueue.serializeTogether([a, b], async () => undefined)
    ).rejects.toThrow('must not await')
    await expect(a.serialize(() => 'after')).resolves.toBe('after')
  })

  it('refuses an already-admitted compound when one predecessor poisons its lane', async () => {
    const a = new JournalWriteQueue('a')
    const b = new JournalWriteQueue('b')
    const unrelated = new JournalWriteQueue('unrelated')
    let compound: Promise<unknown> = Promise.resolve()
    let after: Promise<unknown> = Promise.resolve()
    const order: string[] = []
    await a.serialize(() => {
      compound = JournalWriteQueue.serializeTogether([b, a], () => order.push('stale compound'))
      after = b.readInOrder(() => order.push('unpoisoned read'))
      a.poison(new Error('prior durable adoption failed'))
    })
    await expect(compound).rejects.toMatchObject({ code: 'journal_closed' })
    await after
    await unrelated.serialize(() => order.push('unrelated'))
    expect(order).toEqual(['unpoisoned read', 'unrelated'])
  })

  it('runs synchronously when all lanes are idle, including the next ordinary write', async () => {
    const a = new JournalWriteQueue('a')
    const b = new JournalWriteQueue('b')
    const order: string[] = []
    const compound = JournalWriteQueue.serializeTogether([a, b], () => order.push('compound'))
    const next = a.serialize(() => order.push('next'))
    expect(order).toEqual(['compound', 'next'])
    await Promise.all([compound, next])
  })

  it('installs every ticket before invoking a reentrant callback', async () => {
    const a = new JournalWriteQueue('a')
    const b = new JournalWriteQueue('b')
    const order: string[] = []
    const pending: Promise<unknown>[] = []
    pending.push(
      JournalWriteQueue.serializeTogether([a, b], () => {
        pending.push(b.serialize(() => order.push('b-after')))
        pending.push(a.readInOrder(() => order.push('a-read')))
        order.push('compound')
      })
    )
    expect(order).toEqual(['compound'])
    await Promise.all(pending)
    expect(order[0]).toBe('compound')
    expect(order.slice(1).sort()).toEqual(['a-read', 'b-after'])
  })

  it('orders reversed, overlapping and three-lane tickets without blocking unrelated work', async () => {
    const a = new JournalWriteQueue('a')
    const b = new JournalWriteQueue('b')
    const c = new JournalWriteQueue('c')
    const d = new JournalWriteQueue('d')
    const order: string[] = []
    const pending: Promise<unknown>[] = []
    await a.serialize(() => {
      pending.push(a.serialize(() => order.push('a-before')))
      pending.push(JournalWriteQueue.serializeTogether([a, b], () => order.push('ab')))
      pending.push(JournalWriteQueue.serializeTogether([b, a], () => order.push('ba')))
      pending.push(b.readInOrder(() => order.push('read')))
      pending.push(JournalWriteQueue.serializeTogether([c, b], () => order.push('cb')))
      pending.push(JournalWriteQueue.serializeTogether([c, a, b], () => order.push('cab')))
      pending.push(a.serialize(() => order.push('a-after')))
      pending.push(d.serialize(() => order.push('unrelated')))
      expect(order).toEqual(['unrelated'])
    })
    await Promise.all(pending)
    expect(order).toEqual(['unrelated', 'a-before', 'ab', 'ba', 'read', 'cb', 'cab', 'a-after'])
  })

  it('waits for the predecessors of both busy lanes, even when one fails', async () => {
    const a = new JournalWriteQueue('a')
    const b = new JournalWriteQueue('b')
    const order: string[] = []
    const pending: Promise<unknown>[] = []
    await a.serialize(() => {
      pending.push(a.serialize(() => order.push('a-before')))
      pending.push(
        b.serialize(() => {
          pending.push(
            b
              .serialize(() => {
                order.push('b-before')
                throw new Error('before failed')
              })
              .catch(() => undefined)
          )
        })
      )
      pending.push(JournalWriteQueue.serializeTogether([a, b], () => order.push('both')))
    })
    await Promise.all(pending)
    expect(order.at(-1)).toBe('both')
    expect(order.slice(0, 2).sort()).toEqual(['a-before', 'b-before'])
  })

  it('preserves admitted work through close, includes it in drain and rejects later admissions', async () => {
    const a = new JournalWriteQueue('a')
    const b = new JournalWriteQueue('b')
    const order: string[] = []
    let pending: Promise<unknown> = Promise.resolve()
    let drain: Promise<void> = Promise.resolve()
    await a.serialize(() => {
      pending = JournalWriteQueue.serializeTogether([a, b], () => order.push('committed'))
      b.markClosed()
      drain = b.drain().then(() => {
        order.push('drained')
      })
    })
    await expect(b.serialize(() => order.push('refused'))).rejects.toMatchObject({
      code: 'journal_closed'
    })
    await Promise.all([pending, drain])
    expect(order).toEqual(['committed', 'drained'])
  })

  it('rejects all admission before modifying an open lane when another is closed', async () => {
    const a = new JournalWriteQueue('a')
    const b = new JournalWriteQueue('b')
    b.markClosed()
    await expect(JournalWriteQueue.serializeTogether([a, b], () => 'no')).rejects.toMatchObject({
      code: 'journal_closed'
    })
    let ran = false
    const next = a.serialize(() => {
      ran = true
    })
    expect(ran).toBe(true)
    await next
  })

  it('cancels at its reserved position, without letting a later read overtake its predecessors', async () => {
    const a = new JournalWriteQueue('a')
    const b = new JournalWriteQueue('b')
    const abort = new AbortController()
    const order: string[] = []
    let cancelled: Promise<unknown> = Promise.resolve()
    let read: Promise<unknown> = Promise.resolve()
    await a.serialize(() => {
      cancelled = JournalWriteQueue.serializeTogether(
        [a, b],
        () => order.push('cancelled'),
        abort.signal
      )
      read = b.readInOrder(() => order.push('read'))
      abort.abort(new Error('cancelled ticket'))
      order.push('before')
    })
    await expect(cancelled).rejects.toThrow('cancelled ticket')
    await read
    expect(order).toEqual(['before', 'read'])
  })

  it('keeps ordered reads around a cancelled ticket after both lane predecessors fail', async () => {
    const a = new JournalWriteQueue('a')
    const b = new JournalWriteQueue('b')
    const abort = new AbortController()
    const order: string[] = []
    const pending: Promise<unknown>[] = []
    let cancelled: Promise<unknown> = Promise.resolve()
    await a.serialize(() => {
      pending.push(
        a
          .serialize(() => {
            order.push('a-failed')
            throw new Error('a')
          })
          .catch(() => undefined)
      )
      pending.push(
        b.serialize(() => {
          pending.push(
            b
              .serialize(() => {
                order.push('b-failed')
                throw new Error('b')
              })
              .catch(() => undefined)
          )
          pending.push(b.readInOrder(() => order.push('before')))
        })
      )
      cancelled = JournalWriteQueue.serializeTogether(
        [a, b],
        () => order.push('cancelled'),
        abort.signal
      )
      pending.push(b.readInOrder(() => order.push('after')))
      abort.abort(new Error('cancelled'))
    })
    await expect(cancelled).rejects.toThrow('cancelled')
    await Promise.all(pending)
    expect(order.indexOf('before')).toBeGreaterThan(order.indexOf('b-failed'))
    expect(order.at(-1)).toBe('after')
    expect(order).not.toContain('cancelled')
  })

  it('blocks already admitted callbacks after poisoning, not just new admissions', async () => {
    const a = new JournalWriteQueue('a')
    const b = new JournalWriteQueue('b')
    let next: Promise<unknown> = Promise.resolve()
    let read: Promise<unknown> = Promise.resolve()
    const order: string[] = []
    await JournalWriteQueue.serializeTogether([a, b], () => {
      next = a.serialize(() => order.push('stale write'))
      read = b.readInOrder(() => order.push('stale read'))
      a.poison(new Error('durable adoption failed'))
      b.poison(new Error('durable adoption failed'))
    })
    await expect(next).rejects.toMatchObject({ code: 'journal_closed' })
    await expect(read).rejects.toMatchObject({ code: 'journal_closed' })
    await Promise.all([a.drain(), b.drain()])
    expect(order).toEqual([])
  })
})
