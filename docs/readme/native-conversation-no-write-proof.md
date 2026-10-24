# Transfer-specific message-not-sent evidence

This proof covers one native **user-turn write**, not every effect of preparation. Provider model or option changes may already have happened. Its user-facing meaning is “message not sent,” not “nothing happened.”

## Durable boundary

The actual target submission remains an ordinary submission without the source card's `queuedMessageId`. Upstream cancellation retains its genuine queued/direct distinction. A separate local pre-write result is carried from the dispatch boundary to the canonical rejected-dispatch receipt.

The pending-dispatch transaction captures the exact transfer binding, pinned original body/options/order, target input fingerprint, operation, conversation/context/native generations, epoch, submission sequence, pending sequence and runtime fence. The recovery-attempt ordinal is derived from canonical pending rows; it is not a mutable retry counter. The rejection and immutable proof commit together through `JournalOperationReceipt`. Failure rolls both back and leaves uncertainty. Accepted dispatch or exact native echo evidence always overrides an older proof, even if the rejected in-memory fold stays terminal.

The proof also binds the original delivery plan and target native identity, plus both participants’ immutable record-birth, account, semantic native-handle and native-generation identities. Its epoch pin has an exact persisted owner; archive cleanup releases only owners belonging to that conversation generation.

## Verified adapter boundaries

- **Claude:** final observer refusal or exact preparation-signal abort before input may prove no user-turn write. Replay/response uncertainty after a possible write does not. Options may change first.
- **Codex:** the initial final observer may establish the same proof. A completed earlier observation permanently disables proof for that attempt: a refused steer frame may already have been written before fallback preparation aborts. The returned admitted/accepted outcome is never overwritten because its signal later aborts.
- **ACP:** host preflight or initial before-dispatch refusal may prove no write. The asynchronous final observer's late generic rejection has no sufficient proof channel and remains unknown, even where a particular test peer wrote no prompt.

The guard uses the existing native context observation, branded pre-dispatch refusal and exact signal-reason identity. A generic rejection, exception name, missing receipt, timeout, or aborted flag is insufficient. An adapter invocation without the observer cannot mint proof. After a successful native observation, even a failure immediately before the actual wire write remains conservatively unproven.

A later pre-write refusal cannot resolve an earlier pending attempt for the same submission. This port does not retry a target submission, so a duplicate pending handover conservatively disables proof; it never infers that an earlier attempt was unwritten from the later refusal.

## Historical evidence is not current permission

`readConversationTransferNoWrite` is the strict runtime classifier: the original epoch, native identity and runtime fence must still match, and the canonical writer-lease check must admit the current owner (including no recovering handoff).

`readHistoricalConversationTransferNoWrite` verifies the pinned historical attempt without mistaking its old runtime fence for today's owner. Ordinary release/reacquisition can preserve the evidence if the logical conversation, context/native generations, candidate, record birth, account and semantic native handle remain the same. Exact old pending/rejected rows and the original plan remain required. A changed generation or native identity disables recovery.

Recovery separately validates a current live, reconciled owned handle and a fresh runtime-fence CAS under its compound transaction. An unreconciled reopened record is not authority, even when its persisted JSON still says live. The historical reader never authorizes Send, Resume or retry. The only supported actions are explicit Return held draft and Cancel while retaining the original intention.

## Bounds and uncertainty

Proof JSON and transfer/plan metadata are limited to 32 KiB; individual journal/native-record reads are byte-gated at 1 MiB. An indexed tail check precedes any range JSON scan: at most 4,096 rows and 8 MiB per window. A normal sequence-1 pin is a whole-epoch retention anchor under the existing pin triggers; it does not claim source coverage through the rejection. Exact attempt rows and their contiguous bounded window are checked separately, so unrelated pre-existing epoch history is not limited. Oversize evidence stays unknown; it does not fabricate proof or suppress an otherwise valid dispatch.

Historical replacement traversal permits at most four newer bounded epochs. Every replacement link and retired tail must exist; any newer dispatch for the target submission or exact echo rejects recovery. Missing/pruned intermediate history, oversized windows or contradictory acceptance fail closed. This is a deliberate false-negative limit, not an unlimited-history or performance claim.

## Scoped evidence

The `conversation-transfer-no-write*.test.ts` suites use real Claude, Codex and ACP adapters with scripted peers and the actual handover/journal path. They cover before/after-write cancellation, Codex steer/fallback ambiguity, absent-observer refusal, same-transaction rollback, accepted-evidence precedence, identity/generation/pin changes, epoch replacement and bounded-history refusal. These tests do not establish authenticated provider behavior or model quality.
