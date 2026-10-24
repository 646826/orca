import { measureCanonicalBenchmark } from './conversation-context-benchmark-canonical-measure'
import { runCancellableBenchmark } from './conversation-context-benchmark-cancel'
import { measureConversationPreparation } from './conversation-context-benchmark-preparation'
import { startBenchmarkLoopMeasurement } from './conversation-context-benchmark-loop.mjs'
import { benchmarkPhase } from './conversation-context-benchmark-process.mjs'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { JournalHostDatabase } from '../../src/main/native-chat/agent-session-journal/journal-host-database'
import { AgentSessionAttachmentStore } from '../../src/main/native-chat/agent-session-attachments/agent-session-attachment-store'
import { agentSessionAttachmentStoreRoot } from '../../src/main/native-chat/agent-session-attachments/agent-session-attachment-references'
import { verifyConversationAttachment } from '../../src/main/native-chat/agent-session-attachments/conversation-attachment-claims'
import { retrieveConversationArtifact } from '../../src/main/native-chat/conversations/conversation-artifact-disclosure'
import { measureConversationJournal } from './conversation-context-benchmark-journal'
import { createSyntheticBenchmarkDisclosure } from './conversation-context-benchmark-fixtures.mjs'

const requestSchema = z.object({
  lane: z.enum(['artifact', 'baseline-artifact', 'cancel-artifact']),
  stateDirectory: z.string().min(1),
  cancelPath: z.string().optional(),
  artifact: z.object({
    path: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
})

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    signal?.throwIfAborted()
    hash.update(chunk)
  }
  return hash.digest('hex')
}

async function run(): Promise<void> {
  const requestPath = process.argv[2]
  if (!requestPath) {
    throw new Error('Missing benchmark request')
  }
  const raw = JSON.parse(await readFile(requestPath, 'utf8'))
  if (['export', 'projection', 'cancel-export', 'cancel-projection'].includes(raw.lane)) {
    const request = z
      .object({
        lane: z.enum(['export', 'projection', 'cancel-export', 'cancel-projection']),
        stateDirectory: z.string().min(1),
        cancelPath: z.string().optional()
      })
      .parse(raw)
    console.log(JSON.stringify(await measureCanonicalBenchmark(request)))
    return
  }
  if (
    raw.lane === 'preparation-full' ||
    raw.lane === 'preparation-budgeted' ||
    raw.lane === 'projection-scale'
  ) {
    const request = z
      .object({
        lane: z.enum(['preparation-full', 'preparation-budgeted', 'projection-scale']),
        stateDirectory: z.string().min(1),
        eventCount: z.number().int().positive().multipleOf(10)
      })
      .parse(raw)
    console.log(
      JSON.stringify(
        await measureConversationPreparation({
          ...request,
          policy: request.lane === 'preparation-full' ? 'full' : 'budgeted',
          projection: request.lane === 'projection-scale' ? 'tools' : 'exact'
        })
      )
    )
    return
  }
  if (raw.lane === 'journal' || raw.lane === 'baseline-journal') {
    const request = z
      .object({
        lane: z.enum(['journal', 'baseline-journal']),
        stateDirectory: z.string().min(1),
        eventCount: z
          .number()
          .int()
          .positive()
          .refine((value) => value % 10 === 0)
      })
      .parse(raw)
    console.log(JSON.stringify(await measureConversationJournal(request)))
    return
  }
  const request = requestSchema.parse(raw)
  const setupStarted = performance.now()
  benchmarkPhase('setup-start')
  await mkdir(request.stateDirectory)
  const host = JournalHostDatabase.open(request.stateDirectory)
  let stopLoopMeasurement: ReturnType<typeof startBenchmarkLoopMeasurement> | undefined
  try {
    const store = new AgentSessionAttachmentStore(
      agentSessionAttachmentStoreRoot(request.stateDirectory),
      { hasSession: () => true }
    )
    const snapshot = join(request.stateDirectory, 'synthetic-input')
    await copyFile(request.artifact.path, snapshot)
    const path = await store.importFreshFile(
      'synthetic-evidence.bin',
      snapshot,
      request.artifact.byteLength
    )
    const version = await verifyConversationAttachment({
      stateDirectory: request.stateDirectory,
      path
    })
    if (version.sha256 !== request.artifact.sha256) {
      throw new Error('Synthetic input integrity mismatch')
    }
    host.transaction((db) => {
      db.prepare('INSERT INTO conversations VALUES(?,?)').run(
        'benchmark',
        JSON.stringify({
          conversationId: 'benchmark',
          location: {
            executionHostId: 'local',
            wslDistro: null,
            workspaceId: 'synthetic-folder',
            workspaceKind: 'folder'
          },
          revision: 1,
          contextGeneration: 1,
          activationFence: 1,
          activeSegmentId: 'segment',
          pendingOperationKey: null
        })
      )
      db.prepare('INSERT INTO conversation_segments VALUES(?,?,?,?)').run(
        'segment',
        'benchmark',
        1,
        JSON.stringify({
          segmentId: 'segment',
          conversationId: 'benchmark',
          ordinal: 1,
          sessionId: 'synthetic-session',
          contextGeneration: 1,
          activationFence: 1,
          nativeBindingGeneration: 1,
          startSequence: 1,
          boundary: { sessionId: 'synthetic-session', epoch: 'synthetic', endSequence: 1 }
        })
      )
      db.prepare('INSERT INTO conversation_attachment_claims VALUES(?,?,?,?,?,?)').run(
        'conversation-source:segment',
        version.uploadId,
        version.name,
        version.sha256,
        version.byteLength,
        Date.now()
      )
    })
    const idleRssBytes = process.memoryUsage().rss
    const setupPeakRssBytes = process.resourceUsage().maxRSS * 1024
    const startedAt = new Date().toISOString()
    const setupElapsedMs = performance.now() - setupStarted
    benchmarkPhase('setup-end')
    stopLoopMeasurement = startBenchmarkLoopMeasurement()
    const started = performance.now()
    const claimCount = () =>
      Number(host.db.prepare('SELECT COUNT(*) n FROM conversation_attachment_claims').get()?.n ?? 0)
    let claimsAtAbort = claimCount()
    const operation = await runCancellableBenchmark({
      cancelPath: request.cancelPath,
      start: async (signal) => {
        signal.addEventListener(
          'abort',
          () => {
            claimsAtAbort = claimCount()
          },
          { once: true }
        )
        let outputPath = path
        if (request.lane !== 'baseline-artifact') {
          outputPath = (
            await retrieveConversationArtifact({
              db: host.db,
              stateDirectory: request.stateDirectory,
              store,
              conversationId: 'benchmark',
              contextGeneration: 1,
              segmentId: 'segment',
              path,
              decision: 'include',
              disclosure: createSyntheticBenchmarkDisclosure(version),
              signal
            })
          ).path
        }
        return {
          status: 'completed',
          integrity: (await hashFile(outputPath, signal)) === request.artifact.sha256
        }
      },
      notifyStarted: () => {
        if (request.cancelPath) {
          process.stderr.write('ORCA_BENCHMARK_STARTED\n')
        }
      },
      verifyCleanup: async () =>
        claimCount() === claimsAtAbort &&
        !(await readdir(request.stateDirectory)).some((name) =>
          name.startsWith('.conversation-export-')
        ) &&
        !host.db
          .prepare(
            "SELECT 1 FROM journal_rows WHERE json_extract(row_json,'$.kind')='dispatch' LIMIT 1"
          )
          .get()
    })
    const elapsedMs = performance.now() - started
    const loopMeasurement = stopLoopMeasurement()
    benchmarkPhase('operation-end')
    console.log(
      JSON.stringify({
        ...(operation.status === 'completed' ? operation.value : operation),
        elapsedMs,
        setupElapsedMs,
        idleRssBytes,
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
        setupPeakRssBytes,
        ...loopMeasurement,
        startedAt,
        finishedAt: new Date().toISOString(),
        byteLength: version.byteLength,
        verification: 'Independent bounded hash of output included in elapsed time'
      })
    )
  } finally {
    stopLoopMeasurement?.()
    host.close()
    await rm(request.stateDirectory, { recursive: true, force: true })
    benchmarkPhase('cleanup-end')
  }
}

void run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
