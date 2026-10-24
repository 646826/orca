# Host-owned compound journal writes

`appendJournalHostCompound` commits related rows in distinct sessions on the **same
`JournalHostDatabase` instance**. It is for host operations such as a cross-session
queue transfer or an all-participant context clear, not provider dispatch.

## Admission and planning

- Pass the complete participant set before planning. Duplicate sessions, duplicate
  handles, and different database instances are refused.
- Supply `isCurrent(journal)` from the host's authoritative live-journal lookup.
  It is checked at admission, before planning, and inside the transaction. A replay
  handle with the same session ID is not interchangeable with the live handle.
- One FIFO ticket is installed in every participant lane synchronously. Earlier
  writes and ordered reads finish first; later writes and reads cannot overtake
  the ticket. Unrelated lanes continue independently.
- Planning runs synchronously only after every predecessor has settled. When all
  lanes are idle, planning, commit, and adoption finish before the call returns.
- An optional abort signal cancels before execution at the reserved position; it
  does not remove the ticket early or prove anything about provider delivery.

The planner returns `appends`, an optional shared `receipt`, an optional
`receiptRow`, and optional transactional `validate`. Each append names an admitted
journal and supplies row builders plus its metadata receipt. Results preserve
**append order**, not sorted lane order. An admitted journal may have no append;
an append may contain no rows when only metadata must change.

Use journal-owned plans such as `journal.queuedMessages.plan`,
`journal.planSubmission`, and `journal.context.planClear`. Do not call ordinary
append methods from the planner or recursively acquire lanes. Do not create raw
source rows using another journal's epoch or sequence.

Recovery may use `journal.planRetireSubmission(id, currentFence, historical)`.
It checks the exact retained submission coordinates and fingerprint, refusing a
different live attempt or a linked queue submission. An absent attempt requires
a distinct historical epoch. This plan is not no-write authority: the shared
recovery receipt must validate that immutable proof in the same transaction and
provide the tombstone's exact historical provenance.

## One durable commit, then adoption, then notification

The writer privately prepares each journal's own consecutive sequences, then:

1. Begins one FULL-durability transaction and compares each participant's durable
   epoch, last sequence, and last-row fence using a bounded primary-key tail
   lookup. The maximum execution fence remains a separate authority guard;
   valid batches may end with a lower-fenced generationless queue row.
2. Runs the operation's synchronous validation, inserts all rows, and writes
   per-append metadata receipts.
3. Writes the shared receipt, followed by required per-row provenance. Provenance
   can therefore read the admission or clear metadata in that same transaction.
4. Commits, adopts all metadata receipts and the shared store draft, and folds
   every journal through the ordinary replay reducer.
5. Notifies observers only after all adoption has completed.

Per-append receipts are **journal metadata only**. All mutations to a shared
session store must be composed into **one store receipt/draft**. Composing separate
store receipts can overwrite one draft's in-memory changes with another's.
Receipt row selectors must select actual prepared rows, never guessed cursors.
Callbacks and receipt methods are synchronous; no network, provider dispatch,
await, or observer invocation belongs in the transaction.

## Failure and recovery

- Before COMMIT, any insert, validation, receipt, or provenance failure rolls back
  the entire operation. Receipt rollback hooks invalidate transaction-populated
  metadata caches; no journal fold is adopted.
- After COMMIT, an adoption failure throws `JournalCommittedWriteError` with
  `committed: true`. Every participant lane is poisoned: already-admitted
  callbacks are refused as well as new admissions. Close/drain and reopen from
  durable replay before further writes. This is **not** a rollback or permission
  to dispatch again.
- Observer-only errors are reported without rejecting the successful durable
  operation or poisoning fully adopted state. Epoch publication follows the same
  adoption-before-notification boundary.
- Operation identity and retry policy remain in the durable operation ledger.
  Repeated calls must resolve that receipt before planning another transfer;
  duplicate submission IDs are also rejected by the ordinary submission builder.

Focused regressions live in `journal-write-queue-compound.test.ts` and
`journal-host-compound-writes.test.ts`, beside the ordinary database, queue,
required-provenance, streamed-durability, and epoch-recovery suites.
