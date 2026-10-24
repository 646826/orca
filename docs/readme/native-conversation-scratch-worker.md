# Private conversation projection worker

Status: **implemented intermediate slice; full responsiveness acceptance remains open**.

The canonical journal, source pins, source hashing/proofs, store transactions and native dispatch
still belong to their existing authoritative runtime. This change moves only private presentation
reduction and the complete historical-page index off that runtime's event loop. It does **not**
claim that the previously measured source-transaction stalls are resolved.

The 2026-10-23 controlled 10,000-event replay run subsequently passed its selected gates: median
6.298 s, worst p99 heartbeat 9.46 ms, maximum heartbeat 82.27 ms and incremental RSS 119.9 MB.
These are replay measurements, not a passing result for unselected workloads. Source I/O still
being synchronous is not itself evidence of a measured failure. Full prescribed-workload
acceptance remains open.

The subsequent [launch ledger command boundary](agent-launch-ledger-owner.md) fixes close/reopen
ownership and routes real launch callers through typed commands; it does not move the source
database off-main or establish a need for a broader actor migration.

## Production path

`conversation.history` still enters `readConversationHistoricalPage`. That function admits one
`ConversationScratchClient`, shared by every epoch in the requested page. The worker owns:

- private scratch directory creation, SQLite open/schema setup and replay transactions;
- the existing `startJournalRowFold` reducer with `ConversationReducerDiskItems` storage;
- presentation framing and bounded page serialization;
- `ConversationHistoryIndex` open, append, commit, page construction and cleanup.

The existing replay storage implementation is extracted as `ConversationReplayScratch`; there is
no second reducer, source database connection, SQL-proxy fallback or competing writer. The worker
receives projected rows, never source database paths/handles or authority to create canonical proofs.
Main-side canonical reads remain in 64 KiB chunks. Their original bytes are hashed before the
existing FULL source-proof transaction. Scratch acknowledgment is not delivery evidence.

Presentation leases now have asynchronous `itemPage` and `close` methods. The benchmark caller
awaits both and packages the worker beside its measurement entry. Electron and orcad build manifests
include the same electron-free worker entry; independently updated clients see no new public wire
method or capability. Folder workspaces use the same host-state-directory boundary as worktrees.

## Ordering and current authority

A source pin is acquired before replay. Source proof writes occur only after the private replay
batch acknowledgment and a fresh authority check. Pin validation and the caller's source-revision
check bracket every awaited replay operation. Historical-page publication rechecks source revision
both after the worker page acknowledgment and after awaited cleanup. Clear, replacement, cancellation
and closed-owner state therefore cannot turn an old worker response into present permission.

The worker channel is private to a single job. Monotonically increasing request IDs reject stale or
unexpected responses; clients admit only one command at a time and refuse commands during startup
until the caller has awaited `ready`. There is no queued-payload backlog. Unknown but admissible
render-item fields are validated without schema normalization, preserving forward-compatible bodies,
blocks and extension fields through replay and history transport.

The existing canonical handover commit, provider dispatch, final serializer checks, acceptance
receipts and recovery rules are unchanged. No worker response authorizes or retries a native send.

## Resource bounds

- At most **four** private projection jobs are admitted process-wide; pressure returns an explicit
  resource refusal. This is a concurrent-work limit, not a total conversation/session limit.
- Each admitted job has at most **one** request in flight, with no payload queue.
- Projected batches keep the existing **16 rows / 256 KiB** bounds, including the previously accepted
  isolated oversized row. Historical append commands carry at most 128 already bounded page items.
- Complete request and response envelopes are limited to **8 MiB**, including their correlation ID.
  At most four request envelopes and four response envelopes can be in transport concurrently; this
  64 MiB envelope ceiling is not a claim about total process memory or clone overhead.
- The existing projection limit is one Mi UTF-16 code units, or a normalized lifecycle batch of at
  most 1,500,000 bytes. UTF-8 and outer JSON escaping fit the 8 MiB envelope. Existing presentation
  page budgets remain at most 4 MiB. Oversized original tool output still uses the existing streamed
  projection and exact canonical evidence; no new original-text truncation is introduced.

Worker threads share a process, so process RSS includes their heaps/native allocations. Worker
isolation by itself is not a memory reduction. Source parsing, source transactions, message
serialization and structured-clone costs still require controlled measurement.

## Cancellation, faults and teardown

Cancellation means “stop admitting useful work”, not “SQLite rolled back”. A blocked synchronous
worker call remains pending until it returns or actual thread exit is established. No timeout is
used as a commit, rollback, cancellation or cleanup receipt.

Normal replay close first acknowledges private replay database/directory cleanup, then releases its
source pin. Whole-job close stops command admission, drains its current command, closes the worker,
waits for actual exit and removes the known private UUID directory asynchronously before running
source-pin release callbacks. An unexpected exit cannot publish a page; cleanup still waits for
positive exit evidence. A failed ordinary close remains retryable on the same owner.

Active clients and failed cleanup are retained by the owning state-directory lifetime. Runtime
teardown stops new scratch admission before draining, and cannot close the source journal while
scratch cleanup or its pin release has failed. A new source owner refuses to open over remaining
clients. Retried teardown uses the same source connection; later builds can retry failed private
cleanup while that connection remains valid. This is not a general orphan-recovery system across
process restarts.

## Verification and remaining work

Regression tests exercise real bundled workers and real SQLite, including failed replay COMMIT,
failed reduction, retryable filesystem removal, source revocation/replacement/clear races and
forward-compatible item round trips. A deterministic worker fixture blocks a real scratch COMMIT
with `Atomics.wait`: main-loop cancellation continues, but the build and retention cleanup stay
pending until the test releases that exact block. Runtime-level tests verify source-owner retention
and refusal of replacement after cleanup failure. Negative controls remove authority checks,
release pins early or restore stripping schema parsing to prove the corresponding assertions fail.

These checks are functional boundary evidence, not the three-warmup/ten-measurement performance
acceptance protocol. The previous 10,000-event responsiveness failure remains the current published
checkpoint until a new controlled measurement supersedes it.

The next ownership change must migrate the authoritative journal/store/attachment/compound-write
and final native-dispatch authorization domain coherently, including terminal-launch ledger callers
and profile migration admission. A Promise wrapper or a second source writer is not a substitute.
See [the owner-boundary proposal](native-conversation-worker-boundary-design.md) and
[performance checkpoints](native-conversation-performance-checkpoints.md).
