# Native conversation performance checkpoints

These are experimental, commit-specific measurements, not release acceptance. Selected replay, expanded workloads, and later diagnostics below have different source snapshots and scopes; none establishes full T37 acceptance. Preserve unsuccessful measurements when changing the implementation or measurement method. Functional integrity, bounded memory, responsiveness, complete preparation, and model quality are separate claims.

## 2026-10-23: durable presentation replay before batching

Source commit: `f8b18d91970e6b749df3098f8af9ff175672e36e`.

The controlled Linux run used 52 sequential fresh child processes: three warmups and ten measurements for each of a zero-byte artifact lane, its baseline, a 10,000-event presentation replay lane, and its reducer baseline. No other validation gate ran concurrently. The runner retained identical before/after effective-source fingerprints and a fixed bundle hash. Filesystem/cache and shared-host scheduling variation remain limitations; this is not a dedicated hardware guarantee.

All 52 children completed with integrity checks. Across every replay candidate and baseline observation, an independent audit matched:

- 10,001 canonical rows and 9,552,857 canonical bytes;
- 5,000 final presentation items;
- canonical SHA-256 `9763a77edca6c411dd4f265f4b706060a2cb2bfb97ac916ffa83fba868b2941c`;
- presentation digest `f6ca91e08b5566a23b820b2588d6212b94df2618c9bd4c69a0fc89f0e63465bb`.

| Measurement                     | Candidate presentation replay |         Existing reducer baseline |
| ------------------------------- | ----------------------------: | --------------------------------: |
| Measured repetitions            |                            10 |                                10 |
| Median elapsed time             |                      42.116 s |                           1.034 s |
| Minimum / maximum elapsed time  |             31.174 / 82.037 s |                   0.825 / 1.536 s |
| Maximum incremental OS peak RSS |              30,830,592 bytes |                  56,229,888 bytes |
| Worst recorded histogram p95    |                  1,291.846 ms | Not valid responsiveness evidence |
| Worst recorded histogram p99    |                 14,101.250 ms | Not valid responsiveness evidence |

**Result: responsiveness failed.** Candidate memory stayed below the proposed 128 MiB incremental gate, but that does not compensate for long event-loop stalls. The command also remained incomplete for unselected or unimplemented T37 workloads.

The baseline performs in-memory reduction, whereas the candidate persists source-version proofs and a disk-backed presentation map. It is a useful reference workload, not an equivalent implementation of the complete candidate contract; do not advertise their elapsed-time ratio as an end-to-end speed comparison.

### Production bottleneck

The pre-batching presentation loop committed a source-version transaction for each canonical row, while private scratch-map mutations also autocommitted separately. Yielding every 128 rows accumulated synchronous database work into long stalls. Source founding and initial fixture hashing were outside the timed replay; the repeated replay writes were inside it.

A correction must batch bounded work without weakening durable source writes, spanning a transaction across an await, buffering the whole history, or continuing a partially failed reducer. Previously recorded source-version facts do not by themselves establish successful presentation or context delivery.

### Measurement defect discovered during this run

The original histogram was reset immediately before work and sampled briefly after completion. A fully synchronous first segment could therefore be absent from histogram observations. One baseline observation reported zero samples and approximately 0.000511 ms percentiles while the independent heartbeat recorded a stall above one second. Small baseline histogram percentiles are not evidence of responsiveness.

Retain these raw observations as historical failed/incomplete evidence. Subsequent measurement must cover the first and terminal blocking segments, retain raw heartbeat and histogram values separately, reject insufficient histogram evidence, and avoid manufacturing samples through post-operation waits. Cancellation timing must begin before invoking work, including its initial synchronous segment.

## Bounded replay correction

Presentation replay collects at most 16 projected rows or 256 KiB of their UTF-8 serialized bytes before a synchronous batch. A single larger row is processed alone only if it already satisfies the existing projection/schema limits; this is not a new total-history limit or a claim that total process memory is 256 KiB. Canonical input remains streamed in 64 KiB pieces.

The private scratch reducer is updated in one transaction, followed by one durable source-version transaction with the existing per-row pin, source and proof checks. Both finish before any await. Collection also yields cooperatively after approximately 8 ms without enlarging the bounded batch. No canonical durability setting is relaxed.

Any scratch or source write/commit failure discards the entire unpublished reducer rather than continuing partially mutated in-memory state. Immutable source facts from earlier successful batches remain facts, not evidence that presentation or delivery completed. Abort and authority revocation are checked across yields. An exact pin/source guard runs after the final yield, synchronously immediately before publishing a lease, closing the final-yield revocation window.

Regression coverage includes transaction counts, UTF-8 byte bounds, oversized-row isolation, both database commit failures, prefix facts, fresh replay, abort, revoked retention authority and concurrent appends outside the frozen source range. The controlled post-correction measurements are recorded below; transaction-count reduction alone is not a latency guarantee.

## Measurement version 2

The corrected sampler starts at the operation boundary and stops synchronously when that operation completes. It retains the histogram, independent first/terminal heartbeat intervals, maximum observed stall, and complete measurement-window duration separately. It does not collect post-operation padding samples. A zero-observation histogram reports null percentiles, not a sub-microsecond success.

A statistical histogram result requires at least 100 actual in-operation observations. For a genuinely short operation, an explicitly labelled whole-operation upper bound may instead establish responsiveness: the complete measurement window must contain the reported elapsed time and be at most 50 ms, and every observed heartbeat interval must also be at most 50 ms. This is a conservative duration proof, not a measured p95 or p99. Longer sparse candidate runs remain incomplete. Sparse baseline histograms are disclosed as diagnostics and do not manufacture baseline responsiveness or invalidate otherwise established candidate bounds.

Candidate histogram targets remain p95 at most 50 ms and p99 at most 100 ms. An additional conservative maximum-stall guard refuses any candidate heartbeat interval above 100 ms, including a first or terminal stall that the histogram misses. Cancellation has separate request-observation and cleanup deadlines; its start marker precedes invocation so an initial synchronous segment is not hidden.

Legacy reports cannot establish version-2 measurement correctness. Node timing regressions exercise initial and terminal blocking segments, a genuinely cooperative operation, and cancellation delayed by a synchronous initial segment. Synthetic evaluator cases exercise exact 50 ms boundaries, sparse histograms, malformed windows and legacy reports.

## 2026-10-23: bounded replay with measurement version 2

Source commit: `8d22de185e683436692fc413a089cf33c1a59142`. All 52 fresh-child observations completed with integrity checks, fixed before/after source fingerprints, and the same canonical byte count, row/item counts and hashes as the pre-batching fixture. The independent cross-arm audit also matched every observation.

| Measured candidate replay result     |               Value |
| ------------------------------------ | ------------------: |
| Repetitions after three warmups      |                  10 |
| Median elapsed time                  |             5.826 s |
| Minimum / maximum elapsed time       |    5.391 / 10.140 s |
| Maximum incremental OS peak RSS      |    40,275,968 bytes |
| Worst histogram p95 / p99            | 26.198 / 139.723 ms |
| Worst independent heartbeat interval |        1,671.394 ms |

**Result: improved elapsed time, but responsiveness still fails.** All ten measured replay observations had sufficient in-operation histogram evidence. The p99 target and conservative maximum-stall guard were exceeded; do not hide these tails behind a median or memory pass. The zero-byte artifact samples used the explicitly labelled short-operation bound. Synchronous baseline histograms were sparse and remain diagnostic-only. Other T37 lanes remain unrun or incomplete.

### One bounded call-level diagnostic

A separate, instrumented single run on `8d22de18` preserved source fingerprints and integrity. It is not an acceptance rerun, a fresh measurement of `9fe968ab` or `d5b6203b`, or part of the 3+10 measurement sample. It recorded 10,137.97 ms in presentation building, 114.72 ms in canonical audit, 356.76 ms in page reading/digests and 6.44 ms in lease closing.

All 32 retained slow heartbeat intervals were in presentation building. A 809.61 ms interval enclosed a 794.59 ms scratch transaction with a 249.39 ms synchronous scratch commit. Other scratch commits took 194.63, 189.05 and 131.52 ms. Source pin/proof transactions also took 147.87 and 176.15 ms. The trace establishes synchronous call-level stalls; it does not establish an OS cause or explain every part of each interval.

Shrinking batches cannot bound one slow synchronous commit. Moving scratch work alone also leaves source transactions on the main event loop. At this checkpoint, the [worker and asynchronous journal-owner boundary](native-conversation-worker-boundary-design.md) was only proposed. The later private scratch worker does not implement the full source-owner boundary; neither permits a competing source writer or reduced durability.

## 2026-10-23: selected 10k replay with the real scratch worker

Source: `178a47d9f5d25aaab9e700354d1d388700411771`. One controlled run used the checked-in runner and measurement version 2, with the emitted scratch worker beside the measurement entry: 52 sequential fresh children, three warmups and ten measurements for each replay/baseline and zero-byte artifact/baseline lane. All observations passed integrity; independent fixture reconstruction matched the same 10,001 rows, 9,552,857 bytes, 5,000 items and both hashes recorded above. Tracked/effective source and emitted bundle/worker hashes stayed fixed.

**The selected replay gates passed; full T37 did not.** Check-mode exit 1 represented missing workloads, with zero reported gate failures. Measured candidate median was 6.298 s (range 5.593–7.645 s), worst p95/p99 6.242/9.462 ms and maximum heartbeat 82.267 ms. Maximum incremental process peak RSS was 119,902,208 bytes; whole-process peak was 207,015,936 bytes, including worker memory. The incremental metric subtracts idle RSS from the OS lifetime peak, not an isolated operation peak. This trades substantially more memory and a slightly slower median for better observed responsiveness than the previous checkpoint; it does not prove synchronous main-thread source transactions cannot stall.

Evidence: `validation/async-journal/controlled-replay-178a47d9/` (`RESULT.md`, `independent-audit.json`, `independent-fixture.json`, raw receipts). No acceptance rerun was selected to obtain green.

## 2026-10-23: expanded workloads on c68d1f56

Source: `c68d1f563be9904b0b507fa772e69a3935fa7a7e`. Two independent batches were declared, each with nine lanes and three warmups plus ten measurements per lane. Children ran sequentially, with fixed source and no concurrent validation gate. The 100k-event watchdog was predeclared at 600 seconds; other children retained 120 seconds. A watchdog is an infrastructure bound, not a relaxed performance target.

### Batch A: completed, performance failed

All 117 observations completed their integrity or cancellation-cleanup contract, with independently audited raw results, counts, aggregation, positive child termination and unchanged source/bundles. Actual exit 1 reflects performance failures, not failed child execution; no child timed out.

- Artifact retrieval at 100 MiB and 1 GiB had measured medians 1.859 s and 10.980 s, but maximum heartbeats 426.755 ms and 268.505 ms exceeded the guard.
- Canonical 64 MiB export and tools projection had medians 9.723 s and 22.599 s; worst p99 values 181.404 ms and 838.861 ms, and maximum heartbeats 3,678.868 ms and 5,492.796 ms. Integrity does not compensate for these stalls.
- Canonical export/projection and their cancellation lanes failed the recorded peak-minus-idle memory gate. In every measured observation their final OS lifetime peak equalled setup peak: these failures include setup highwater and do **not** establish additional operation-specific memory growth. The event-loop windows start after setup, so this caveat does not remove their responsiveness failures.
- Projection cancellation warmup 2 exceeded the 250 ms observation deadline (422.359 ms); measured sample 5 exceeded both observation and 1,000 ms unwind deadlines (547.318/1,306.479 ms). All cancellation samples verified active work at the deadline, stopped new dispatch and cleanup. Sparse canonical-cancellation histograms remain insufficient evidence; artifact cancellation had nine measured short-operation bounds and one incomplete longer sparse observation.

Evidence: `validation/async-journal/controlled-expanded-c68d1f56/batch-a/` (`RESULT.md`, `independent-audit.json`, `observations.json`, `results/report.json` and raw receipts). All failures, including warmups, are retained.

### Batch B: infrastructure interruption, not a completed run

The exec-server disconnected at 23:17:38 UTC and reported an executor-key change during session recovery. The old session subsequently became unknown. There is **no known terminal exit and no proof of the old outstanding child's death**; absence from the recovered process namespace is not such proof. This batch was not restarted.

Durable evidence contains 92 verified observations and 93 requests: 78 completed zero-tier/replay observations, 13 projection-1k capacity refusals, and one projection-10k warmup capacity refusal. `projection-scale-10000-warmups-1` has an outstanding request/private profile but no result or termination receipt. Remaining projection observations, including all projection-100k observations, are not established. The zero-byte artifact pair was explicitly selected because the parser requires a nonempty tier list; default large-artifact tiers were not silently added, and measured 10k replay was not repeated.

The completed replay subsets each contain all three warmups and ten measurements in both arms. Independent reconstruction matches all 26 observations per scale: 1k has 1,001 rows/951,553 bytes/500 items; 100k has 100,001 rows/95,916,861 bytes/50,000 items. Measured candidate 1k median was 752.2 ms, worst p99 8.155 ms and maximum heartbeat 27.365 ms. At 100k, median was 68.983 s and worst p99 5.657 ms, but maximum heartbeat 464.836 ms and incremental lifetime peak 286,588,928 bytes failed the limits. Whole-process peak was 389,971,968 bytes; additional highwater above setup reached 286,457,856 bytes. A good p99 does not override memory or maximum-stall failure.

Projection refusals report `resource-limit`, not success; native acceptance was not run. Production bounds serialized inline representations and the complete envelope to 1 MiB, not merely raw canonical bytes. The receipts do not identify the exact refusing branch. These scale fixtures contain no tool-output heads, so even a future successful scale result would not by itself prove summary-transformation scaling; the separate transformed 512 KiB regression is distinct evidence.

Available raw receipts, hashes, cross-arm equality and tracked-source continuity at recovery were audited. Full-lane/count/final-source checks correctly remain incomplete; no final aggregate evaluation was fabricated. Evidence: `validation/async-journal/controlled-expanded-c68d1f56/batch-b/` (`RESULT.md`, `infrastructure-interruption.json`, `independent-audit.json`, `fixture-comparison.json` and raw receipts). The interruption does not establish OOM or any product failure cause.

## 2026-10-23: transport preflight and bounded diagnostics

Source: `b121661701d0091bb68feb31f8f5a90ae7205b4e`. The transport preflight avoids whole-row transport JSON probing when no relevant trigger reservation exists; it retains the original proof path when one exists. Its six-file regression run passed 45 tests after three expected RED failures, with typecheck and quality gates passing. This is functional evidence, not a new controlled performance pass. Receipts: `validation/async-journal/transport-preflight/`.

Two sequential, instrumented diagnostic children (artifact 100 MiB and canonical export 64 MiB) exited 0 with verified termination and integrity; source hashes stayed fixed. Their instrumentation was confined to emitted bundles. In export, 152 synchronous row-slice SQLite reads consumed 7,444.18 ms of 9,408.30 ms elapsed (about 79%); maximum read was 118.22 ms. Validator writes totalled 260.10 ms, maximum 13.18 ms; FULL commits totalled 34.50 ms, maximum 2.77 ms. No full transport JSON join executed. This attributes the dominant observed work to repeated canonical-byte acquisition, not to validator yielding or commit latency in that observation. Other JSON scans included benchmark audit overhead and production delivery-boundary checks; attribution of the latter is static caller inference, not individually tagged stack evidence. The earlier artifact tail did not reproduce, so no fsync/verification removal is justified.

Export setup/final lifetime peak was 896,118,784 bytes. Setup-end current RSS was 367,575,040 bytes and sampled operation maximum 457,760,768 bytes. That sampled increase is **not** an operation-peak upper bound: the 10 ms timer cannot observe peaks within synchronous calls and cannot replace the existing memory gate. Evidence: `validation/async-journal/diagnostic-b1216617-20261023T232554/analysis.md`, raw traces and process receipts.

A separate emitted-bundle-only experiment acquired an eligible row once and returned chunk subarrays instead of repeatedly materializing it. Exact 64 MiB content, all 13 canonical sources and integrity were preserved; its child exited 0 with verified termination and unchanged source. Elapsed time fell to 1.930 s in this single instrumented observation, but this is not a controlled speedup claim. Individual 64 MiB acquisitions remained about 97–98 ms, maximum heartbeat was 281.70 ms, and sampled operation RSS increased 133,799,936 bytes—only 417,792 bytes below 128 MiB, without being an upper bound. Earlier buffers remained visible in external memory after cache references were cleared; logical release does not prove memory reclamation.

**The whole-row cache was rejected as a production-ready fix.** Shorter elapsed time does not justify its indivisible read, negligible observed memory margin or remaining boundary-scan stalls. No forced GC, reduced accepted content or threshold relaxation was used. Evidence: `validation/async-journal/diagnostic-single-row-b1216617-20261023T233204/analysis.md` and raw receipts. These diagnostics do not resolve the interrupted Batch B child's lifecycle or complete T37.

## Remaining acceptance work

See [the verification matrix](native-conversation-switching-verification.md#performance-verification-protocol-t37). This replay lane does not measure complete context preparation/consent/export, native dispatch, model recall, 200-item rendered history latency, repeated activation retention, or all large-artifact workloads. Source-boundary queries also still parse canonical row JSON; improving presentation replay does not establish complete preparation scalability.
