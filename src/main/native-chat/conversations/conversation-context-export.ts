import type {
  ConversationExportSelection,
  ConversationExportedRow
} from './conversation-context-export-types'
export type {
  ConversationExportSelection,
  ConversationExportedRow
} from './conversation-context-export-types'
import { writeConversationExportBytes as writeAll } from './conversation-context-export-io'
import {
  resolveConversationDisclosure,
  recordConversationExportDisclosures,
  type ConversationDisclosureAuthority
} from './conversation-source-disclosure'
import { recordConversationExportSources } from './conversation-context-export-proof'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate as yieldToHost } from 'node:timers/promises'
import type { ConversationEvidenceGap } from '../../../shared/conversation-handoff'
import {
  assertConversationExportScope,
  ConversationExportError,
  publishConversationSnapshot,
  type ConversationExportArtifact,
  type ConversationExportScope
} from './conversation-artifact-disclosure'
import {
  pinJournalEpoch,
  releaseJournalEpochPins
} from '../agent-session-journal/journal-epoch-pins'
import { runJournalTransaction } from '../agent-session-journal/journal-transaction'
import type { JournalEpochPin } from '../agent-session-journal/journal-epoch-pins'
import { authorizeConversationSourceAtoms } from './conversation-source-atoms'
import {
  assertUniqueExportSources,
  recordExportSourceVersions,
  assertConversationExportSource as assertSource
} from './conversation-context-export-authority'
import { createConversationCanonicalRowValidator } from './conversation-canonical-row-validation'

const INLINE_ROW_LIMIT = 64 * 1024 * 1024
const SQL_CHUNK_BYTES = 1024 * 1024
/** Exact original events, not a reduced model history or evidence of permanent model conditioning. */
async function exportContext(
  input: ConversationExportScope & {
    sources: readonly ConversationExportSelection[]
    disclosure?: ConversationDisclosureAuthority
  },
  pins: readonly JournalEpochPin[]
): Promise<{
  artifact: ConversationExportArtifact
  rows: ConversationExportedRow[]
  gaps: ConversationEvidenceGap[]
}> {
  assertConversationExportScope(input)
  const sources = input.sources.map((selection) => ({
    ...selection,
    source: { ...selection.source }
  }))
  const resolve = (selection: ConversationExportSelection) => {
    const fact = resolveConversationDisclosure(input, selection.source)
    if (selection.decision === 'exclude') {
      fact.action = 'exclude'
      fact.reason = 'user-policy'
    }
    fact.critical ||= selection.critical
    return fact
  }
  const decisions = sources.map(resolve)
  for (const selection of sources) {
    assertSource(input, selection)
  }
  const recheck = (): void => {
    for (const [index, selection] of sources.entries()) {
      assertSource(input, selection)
      const current = resolve(selection)
      if (
        current.action !== decisions[index]!.action ||
        current.reason !== decisions[index]!.reason ||
        current.critical !== decisions[index]!.critical
      ) {
        throw new ConversationExportError('excluded')
      }
      if (
        current.contextGeneration !== decisions[index]!.contextGeneration ||
        current.targetBindingDigest !== decisions[index]!.targetBindingDigest ||
        current.version.sha256 !== decisions[index]!.version.sha256
      ) {
        throw new ConversationExportError('scope')
      }
    }
  }
  const temporary = await mkdtemp(join(input.stateDirectory, '.conversation-export-'))
  const snapshotPath = join(temporary, 'snapshot')
  const rows: ConversationExportedRow[] = [],
    gaps: ConversationEvidenceGap[] = []
  const digest = createHash('sha256')
  let byteLength = 0
  try {
    const output = await open(snapshotPath, 'wx', 0o600)
    try {
      const write = async (bytes: Uint8Array): Promise<void> => {
        await writeAll(output, bytes, input.signal)
        digest.update(bytes)
        byteLength += bytes.length
      }
      for (const [index, selection] of sources.entries()) {
        const decision = decisions[index]!
        assertSource(input, selection)
        const { source } = selection
        if (decision.action === 'exclude') {
          gaps.push({ source, reason: 'excluded', critical: decision.critical })
          continue
        }
        const stored = input.db
          .prepare(
            'SELECT octet_length(row_json) byte_length FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?'
          )
          .get(source.sessionId, source.epoch, source.sequence)
        if (typeof stored?.byte_length !== 'number') {
          throw new ConversationExportError('missing-source')
        }
        const length = stored.byte_length
        if (!Number.isSafeInteger(length) || length < 1) {
          throw new ConversationExportError('corrupt-source')
        }
        if (length > INLINE_ROW_LIMIT) {
          throw new ConversationExportError('resource-limit')
        }
        const frameOffset = byteLength
        await write(
          Buffer.from(
            `${JSON.stringify({ format: 'orca-canonical-row-v1', source, byteLength: length })}\n`
          )
        )
        const byteOffset = byteLength,
          hash = createHash('sha256'),
          decoder = new TextDecoder('utf-8', { fatal: true }),
          validator = createConversationCanonicalRowValidator(input.db, input, source, length)
        const query = input.db.prepare(
          'SELECT substr(CAST(row_json AS BLOB),?,?) bytes FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?'
        )
        for (let offset = 0; offset < length;) {
          assertSource(input, selection)
          const size = Math.min(SQL_CHUNK_BYTES, length - offset)
          const chunk = query.get(
            offset + 1,
            size,
            source.sessionId,
            source.epoch,
            source.sequence
          )?.bytes
          if (!(chunk instanceof Uint8Array) || chunk.length !== size) {
            throw new ConversationExportError('missing-source')
          }
          hash.update(chunk)
          try {
            validator.write(decoder.decode(chunk, { stream: true }))
          } catch (error) {
            if (error instanceof ConversationExportError) {
              throw error
            }
            throw new ConversationExportError('corrupt-source')
          }
          await write(chunk)
          offset += size
          await yieldToHost()
        }
        try {
          validator.write(decoder.decode())
        } catch (error) {
          if (error instanceof ConversationExportError) {
            throw error
          }
          throw new ConversationExportError('corrupt-source')
        }
        const validation = validator.end()

        if (validation.capturedIncomplete) {
          gaps.push({ source, reason: 'captured-incomplete', critical: decision.critical })
        }
        if (
          validation.envelope.epoch !== source.epoch ||
          validation.envelope.sequence !== source.sequence ||
          (source.itemId !== undefined && source.itemId !== validation.envelope.itemId) ||
          (source.itemRevision !== undefined &&
            source.itemRevision !== validation.envelope.itemRevision)
        ) {
          throw new ConversationExportError('corrupt-source')
        }
        const sha256 = hash.digest('hex')
        if (sha256 !== decision.version.sha256) {
          throw new ConversationExportError('corrupt-source')
        }
        if (
          validation.envelope.kind === 'lifecycle-batch' &&
          !authorizeConversationSourceAtoms(input.db, {
            conversationId: input.conversationId,
            contextGeneration: input.contextGeneration,
            source,
            sha256,
            mutationCount: validation.mutationCount
          })
        ) {
          throw new ConversationExportError('scope')
        }
        rows.push({
          version: { source, sha256 },
          kind: validation.envelope.kind,
          mutationCount: validation.mutationCount,
          frameOffset,
          byteOffset,
          byteLength: length,
          substitutedValidationPaths: validation.substitutedPaths
        })
        await write(Buffer.from('\n'))
      }
      await output.sync()
    } finally {
      await output.close()
    }
    const artifact = await publishConversationSnapshot({
      ...input,
      snapshotPath,
      name: 'conversation-evidence.orca',
      byteLength,
      sha256: digest.digest('hex'),
      recheck,
      commit: (artifact) => {
        recordExportSourceVersions(input, pins, rows)
        recordConversationExportDisclosures(input.db, {
          artifact,
          conversationId: input.conversationId,
          contextGeneration: input.contextGeneration,
          decisions
        })
        recordConversationExportSources(input.db, {
          artifact,
          conversationId: input.conversationId,
          contextGeneration: input.contextGeneration,
          rows
        })
      }
    })
    return { artifact, rows, gaps }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

const exportingDatabases = new WeakSet<object>()
export async function exportConversationContext(
  input: Parameters<typeof exportContext>[0]
): ReturnType<typeof exportContext> {
  if (input.sources.length > 256 || exportingDatabases.has(input.db)) {
    throw new ConversationExportError('resource-limit')
  }
  input = {
    ...input,
    sources: structuredClone(input.sources),
    disclosure: input.disclosure ? { ...input.disclosure } : undefined
  }
  assertUniqueExportSources(input.sources)
  exportingDatabases.add(input.db)
  const pins: JournalEpochPin[] = []
  const ownerId = `conversation-export-read:${randomUUID()}`
  try {
    runJournalTransaction(input.db, () => {
      const ends = new Map<string, { sessionId: string; epoch: string; endSequence: number }>()
      for (const selection of input.sources) {
        assertSource(input, selection)
        const key = JSON.stringify([selection.source.sessionId, selection.source.epoch])
        const previous = ends.get(key)
        ends.set(key, {
          sessionId: selection.source.sessionId,
          epoch: selection.source.epoch,
          endSequence: Math.max(previous?.endSequence ?? 0, selection.source.sequence)
        })
      }
      for (const boundary of ends.values()) {
        pins.push(pinJournalEpoch(input.db, { ownerId, ...boundary }))
      }
    })
    return await exportContext(input, pins)
  } finally {
    try {
      runJournalTransaction(input.db, () => releaseJournalEpochPins(input.db, ownerId))
    } finally {
      exportingDatabases.delete(input.db)
    }
  }
}

export { streamConversationExportRows } from './conversation-context-export-reader'
