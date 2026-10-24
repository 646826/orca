# Launch ledger command boundary

`agent.launch` uses a typed, **in-process** `AgentLaunchLedger` endpoint instead of receiving the
mutable session record store. This is a production-connected ownership boundary, not a source
database worker or an additional writer. The chat host and terminal launch ledger still share
one source connection, store and synchronous transaction domain.

The owner implements admission/conditional claim, provisional or final result recording, failure
recording and ordered publication eligibility. Admission and claim retain their existing single
durable transaction. The external terminal/chat effect begins only after its successful reply.
The provisional write enters the existing store FIFO immediately, even though its caller does not
await it; the final write cannot overtake it. Input/output DTOs are copied without schema
normalization, preserving future fields. An unreadable recorded result refuses that operation;
it does not erase the row or prevent unrelated launches.

Client capability presentation and live terminal-handle remapping remain outside the owner.
There is no public wire-protocol change and no change to native delivery acceptance.

## Optional early tab

An already-open owner answers eligibility in store order. An opening owner must finish before its
answer is used. A cold, stopped or unavailable owner answers **unknown**, which skips only the
optional early tab. Normal launch admission still opens the store and executes or replays as
before. This deliberately changes cold-start presentation: a replay no longer creates a temporary
tab merely because the durable ledger has not been opened yet. Read failures cannot reject the
normal launch. A concurrently recorded operation can still require withdrawal of a previously
published optional tab; that existing behavior is retained.

## Lifetime

Stop fences new public ledger commands before awaiting accepted commands. An old endpoint remains
stopped after a later owner incarnation opens. Host/provider lifecycle settlement continues on the
same store during teardown; the public fence does not disable those necessary tail transactions.
The singleton and delivery binding are retained until the exact source database closes. Failed
standalone close, failed host teardown and failed partial-startup cleanup cannot admit a second
writer. Cleanup is explicitly retried; a timeout never proves rollback or successful close.

Command drain is **not** the lifetime of an external terminal effect between claim and settlement.
A stale settlement fails rather than targeting a new owner. Existing claimed/unknown outcomes
remain durable; nothing automatically resends a launch or tool. A future off-main source actor
would still need to own the dispatch permission and external-effect lifetime coherently.

The private conversation scratch worker is a separate change. Passing measured replay
responsiveness gates does not require claiming that source I/O is already off-main, and unrun
workloads must not be reported as passing. Broader actor migration should be assessed against the
complete prescribed workload evidence rather than inferred solely from synchronous source code.
