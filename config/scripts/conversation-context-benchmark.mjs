#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { availableParallelism, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { runProcess } from '@orca/process-host'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import {
  benchmarkChildTimeoutMs,
  benchmarkChildReceipt,
  benchmarkChildSample
} from './conversation-context-benchmark-process.mjs'
import {
  createBenchmarkArtifact,
  createBenchmarkRunDirectory
} from './conversation-context-benchmark-fixtures.mjs'
import {
  CONVERSATION_BENCHMARK_REQUIRED_LANES,
  evaluateConversationBenchmark,
  parseConversationBenchmarkArgs
} from './conversation-context-benchmark-report.mjs'

const root = resolve(import.meta.dirname, '../..')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function sourceIdentity(directory) {
  const head = await runProcess({
    program: 'git',
    args: ['rev-parse', 'HEAD'],
    cwd: directory,
    timeoutMs: 10000,
    maxOutputBytes: 4096
  })
  const dirty = await runProcess({
    program: 'git',
    args: ['status', '--porcelain'],
    cwd: directory,
    timeoutMs: 10000,
    maxOutputBytes: 1024 * 1024
  })
  if (head.code !== 0 || dirty.code !== 0 || head.outputTruncated || dirty.outputTruncated) {
    throw new Error('Cannot establish benchmark source identity')
  }
  return { head: head.stdout.trim(), dirty: dirty.stdout.length > 0 }
}

async function bundleChild() {
  const bundled = await build({
    entryPoints: [join(root, 'config/scripts/conversation-context-benchmark-child.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    metafile: true
  })
  const worker = await build({
    entryPoints: [
      join(root, 'src/main/native-chat/conversations/conversation-scratch-worker-entry.ts')
    ],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    metafile: true
  })
  return {
    code: bundled.outputFiles[0].contents,
    workerCode: worker.outputFiles[0].contents,
    inputs: [...Object.keys(bundled.metafile.inputs), ...Object.keys(worker.metafile.inputs)]
  }
}

async function fingerprint(inputs) {
  const files = [
    ...new Set([
      ...inputs,
      'package.json',
      'pnpm-lock.yaml',
      'config/scripts/conversation-context-benchmark.mjs',
      'config/scripts/conversation-context-benchmark-report.mjs',
      'config/scripts/conversation-context-benchmark-fixtures.mjs',
      'config/scripts/conversation-context-benchmark-process.mjs',
      'config/scripts/counterbalanced-benchmark-schedule.mjs',
      'config/scripts/benchmark-sample-summary.mjs'
    ])
  ].sort()
  const digests = []
  for (const file of files) {
    digests.push([file, hash(await readFile(resolve(root, file)))])
  }
  return hash(JSON.stringify(digests))
}

export async function runConversationBenchmark(argv = process.argv.slice(2)) {
  const options = parseConversationBenchmarkArgs(argv)
  const output = resolve(
    options.output ?? join(root, 'test-results', `conversation-context-${Date.now()}`)
  )
  await createBenchmarkRunDirectory(output)
  const candidate = await sourceIdentity(root)
  const baseline = options.baselineRoot ? await sourceIdentity(resolve(options.baselineRoot)) : null
  const bundled = await bundleChild()
  const entry = join(output, 'measurement.cjs')
  await writeFile(entry, bundled.code, { flag: 'wx', mode: 0o600 })
  await writeFile(join(output, 'conversation-scratch-worker-entry.js'), bundled.workerCode, {
    flag: 'wx',
    mode: 0o600
  })
  const before = await fingerprint(bundled.inputs)
  const supported = new Set([
    ...options.tiers.map((tier) => `artifact-${tier}`),
    ...options.projections.map((size) => `projection-${String(size)}`),
    ...(options.canonical ? ['export-64', 'projection-64'] : []),
    ...(options.cancellation ? ['cancel-export', 'cancel-projection', 'cancel-artifact'] : [])
  ])
  const report = {
    schemaVersion: 2,
    startedAt: new Date().toISOString(),
    candidate,
    baseline,
    sourceBefore: before,
    sourceAfter: null,
    bundleSha256: hash(bundled.code),
    scratchWorkerSha256: hash(bundled.workerCode),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cores: availableParallelism(),
      memoryBytes: totalmem()
    },
    method:
      'Fresh measurement subprocesses; three filesystem-cache warmups then ten measured runs; no forced GC. Peak RSS minus idle RSS is a conservative upper bound including any earlier setup high-water, not exact operation-only memory. Setup high-water is reported. Canonical64 lanes measure export/tools projection plus independent original-byte audit; source founding/freeze is setup and reported in setup high-water. Cancellation is parent-requested10ms after work-start marker;2ms child polling is included in observation latency. HOME is unchanged.',
    childWatchdogMethod:
      'Predeclared 600 seconds for 100k event children, 120 seconds otherwise, including setup and cleanup. This infrastructure budget is not an acceptance threshold. Timeout phase, signal, actual exit and raw outputs are retained; timeout never passes a workload.',
    projectionMethod:
      'Projection scale lanes run the actual preparation service/tools projector/paged compiler/consent/save with synthetic retrieval capability and independent canonical/exported-byte audits. The unchanged mixed scale fixture has tool input/state but no output heads, so this is not summary-transformation scaling; the separate 512KiB regression proves a real transformation only at that size. Production limits are unchanged; capacity refusal is incomplete. Native delivery is not measured.',
    eventLoopMethod:
      'Version 2: histogram and 1 ms heartbeat span only the operation, including its audit and cancellation cleanup. No priming, histogram reset or post-work padding. Raw histogram p95/p99 require at least 100 in-operation observations. A shorter candidate may instead establish responsiveness by a separately labelled whole-operation upper bound: the entire loopWindowMs encloses elapsedMs and is <= 50 ms, with heartbeatMaxMs <= 50 ms. Otherwise sparse candidate histograms remain incomplete. Raw percentiles are never substituted or fabricated. Histogram startup can omit the first synchronous segment, so independent first/terminal heartbeat intervals also enforce a conservative 100 ms maximum-stall guard. This guard is not a p99 estimate. Raw histogram p95 <= 50 ms and p99 <= 100 ms targets are unchanged. Baseline histogram sufficiency and delays are diagnostic only, not candidate acceptance gates. The cancellation marker precedes invocation so the first synchronous segment is not excluded from observation latency.',
    baselineMethod:
      'Counterbalanced bounded file read/hash equivalent on the same synthetic bytes, not historical conversation switching. Baseline checkout identity is recorded only; Journal baseline uses the same current existing in-memory reducer against the same mixed events; journal candidate is production presentation replay plus a separate canonical source-byte audit, not full preparation/projection compilation. Preparation full/budgeted lanes exercise the production service with synthetic target evidence and have no matched preparation baseline.',
    lanes: [],
    deferred: CONVERSATION_BENCHMARK_REQUIRED_LANES.filter((name) => !supported.has(name)).map(
      (name) => ({
        name,
        reason: name.startsWith('artifact-')
          ? 'Integrated lane not selected in this run'
          : name.startsWith('projection-') && options.preparations.length
            ? 'Separate full/budgeted exact preparation lanes are selected; this required scale/tool-projection gate is not established by them'
            : 'Required workload not integrated with this runner'
      })
    )
  }
  const save = async () =>
    writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  await save()
  const workloads = [
    ...options.tiers.map((size) => ({ size, arm: 'artifact' })),
    ...(options.canonical ? ['export', 'projection'].map((arm) => ({ size: 64, arm })) : []),
    ...(options.cancellation
      ? ['cancel-export', 'cancel-projection', 'cancel-artifact'].map((arm) => ({
          size: arm === 'cancel-artifact' ? 100 : 64,
          arm
        }))
      : []),
    ...options.events.map((size) => ({ size, arm: 'journal' })),
    ...options.projections.map((size) => ({ size, arm: 'projection-scale' })),
    ...options.preparations.flatMap((size) =>
      ['preparation-full', 'preparation-budgeted'].map((arm) => ({ size, arm }))
    )
  ]
  for (const { size: mib, arm: candidateArm } of workloads) {
    const artifact =
      candidateArm === 'artifact' || candidateArm === 'cancel-artifact'
        ? await createBenchmarkArtifact(
            join(output, `${candidateArm}-${mib}.bin`),
            mib * 1024 * 1024
          )
        : null
    await writeFile(join(output, `${candidateArm}-${mib}.json`), JSON.stringify(artifact), {
      flag: 'wx'
    })
    const arms =
      candidateArm.startsWith('preparation-') ||
      candidateArm === 'projection-scale' ||
      ['export', 'projection'].includes(candidateArm) ||
      candidateArm.startsWith('cancel-')
        ? [candidateArm]
        : [candidateArm, `baseline-${candidateArm}`]
    const lanes = Object.fromEntries(
      arms.map((arm) => [
        arm,
        {
          name: arm.startsWith('cancel-')
            ? arm
            : `${arm === 'projection-scale' ? 'projection' : arm}-${mib}`,
          phase: 'process-cold-cache-warm',
          warmups: [],
          samples: []
        }
      ])
    )
    report.lanes.push(...Object.values(lanes))
    const run = async (arm, phase, index) => {
      const name = `${arm}-${mib}-${phase}-${index}`
      const requestPath = join(output, `${name}.request.json`)
      const cancelPath = arm.startsWith('cancel-') ? join(output, `${name}.cancel`) : undefined
      let cancelWrite = Promise.resolve(),
        startObserved = false,
        stderrPrefix = ''
      let cancelTimer, cancelFailure

      await writeFile(
        requestPath,
        JSON.stringify({
          lane: arm,
          cancelPath,
          ...(artifact ? { artifact } : { eventCount: mib }),
          stateDirectory: join(output, `${name}.profile`)
        }),
        { flag: 'wx', mode: 0o600 }
      )
      const timeoutMs = benchmarkChildTimeoutMs(arm, mib)
      let terminationVerified = false
      const result = await runProcess({
        program: process.execPath,
        args: [entry, requestPath],
        cwd: root,
        env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
        timeoutMs,
        terminationBarrier: true,
        onChildTerminated: () => {
          terminationVerified = true
        },
        maxOutputBytes: 1024 * 1024,
        onStderr: (chunk) => {
          if (!cancelPath || startObserved) {
            return
          }
          stderrPrefix = (stderrPrefix + String(chunk)).slice(-256)
          if (!stderrPrefix.includes('ORCA_BENCHMARK_STARTED\n')) {
            return
          }
          startObserved = true
          cancelTimer = setTimeout(() => {
            cancelWrite = writeFile(
              `${cancelPath}.pending`,
              String(Number(process.hrtime.bigint()) / 1e6),
              {
                flag: 'wx',
                mode: 0o600
              }
            )
              .then(() => rename(`${cancelPath}.pending`, cancelPath))
              .catch((error) => {
                cancelFailure = error
              })
          }, 10)
        }
      })
      clearTimeout(cancelTimer)
      await cancelWrite
      await writeFile(join(output, `${name}.log`), result.stderr)
      await writeFile(join(output, `${name}.stdout.log`), result.stdout)
      const receipt = benchmarkChildReceipt(result, timeoutMs, terminationVerified)
      await writeFile(join(output, `${name}.process.json`), JSON.stringify(receipt, null, 2))
      if (cancelFailure) {
        throw cancelFailure
      }
      const sample = benchmarkChildSample(result, receipt)
      lanes[arm][phase].push(sample)
      await save()
      if (!receipt.terminationVerified) {
        report.stoppedReason = 'Child termination not verified; no further measurements scheduled'
        report.sourceAfter = await fingerprint(bundled.inputs)
        report.finishedAt = new Date().toISOString()
        report.evaluation = evaluateConversationBenchmark(report)
        await save()
        throw new Error(report.stoppedReason)
      }
    }
    for (let index = 0; index < options.warmups; index++) {
      for (const arm of arms) {
        await run(arm, 'warmups', index)
      }
    }
    const schedule =
      arms.length === 1
        ? Array.from({ length: options.runs }, () => arms)
        : buildCounterbalancedSchedule(options.runs, candidateArm, `baseline-${candidateArm}`)
    for (const [index, pair] of schedule.entries()) {
      for (const arm of pair) {
        await run(arm, 'samples', index)
      }
    }
  }
  report.sourceAfter = await fingerprint(bundled.inputs)
  report.finishedAt = new Date().toISOString()
  report.evaluation = evaluateConversationBenchmark(report)
  await save()
  console.log(
    JSON.stringify({ report: join(output, 'report.json'), ...report.evaluation }, null, 2)
  )
  return options.check && report.evaluation.status !== 'passed' ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runConversationBenchmark()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
