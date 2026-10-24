import {
  readConversationTransportSubmission,
  prepareConversationTransportSubmission
} from './conversation-transport-submission'
import { canonicalSourceRequiresInline } from './conversation-context-constraints'
import { checkConversationPreparationText } from './conversation-preparation-sensitive'
import {
  projectConversationDisclosedRow,
  ConversationRowProjectionError
} from './conversation-context-projected-row'
import type { ConversationPageEvidenceResolvers } from './conversation-context-page-evidence'
import { ConversationExportError } from './conversation-export-error'
import type Database from '../../sqlite/sync-database'
import type { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import type {
  ConversationContextOriginal,
  ConversationContextRepresentation
} from '../../../shared/conversation-handoff'
import {
  readConversationPreparationSourceRows,
  type ConversationPreparationSources
} from './conversation-preparation-sources'
import { exportConversationContext } from './conversation-context-export'
import { conversationEvidenceKey } from './conversation-context-policy'
import {
  projectConversationTransportRow,
  verifyConversationTransportProjection
} from './conversation-transport-projection'

export class ConversationPreparationRowsRefusal extends Error {}
type PreparationRowsInput = {
  db: Database.Database
  store: AgentSessionAttachmentStore
  stateDirectory: string
  conversationId: string
  snapshot: ConversationPreparationSources
  targetBindingDigest: string
  maxBytes: number
  signal: AbortSignal
}
type PreparationRow = {
  original: ConversationContextOriginal
  representation: ConversationContextRepresentation
}
export async function* prepareConversationExactRows(
  input: PreparationRowsInput
): AsyncGenerator<PreparationRow> {
  for await (const row of readConversationPreparationSourceRows(
    input.db,
    input.snapshot.ownerId,
    input.signal
  )) {
    const authenticated = readConversationTransportSubmission(
      input.db,
      input.snapshot,
      row.version.source
    )
    if (row.byteLength > (authenticated?.rowByteLimit ?? input.maxBytes)) {
      throw new ConversationPreparationRowsRefusal('resource-limit')
    }
    const chunks: Buffer[] = []
    try {
      for await (const chunk of checkConversationPreparationText(row.readChunks())) {
        chunks.push(Buffer.from(chunk))
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'known-sensitive-source') {
        throw new ConversationPreparationRowsRefusal(error.message)
      }
      throw error
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    const transport = projectConversationTransportRow(
      input.db,
      { conversationId: input.conversationId, contextGeneration: input.snapshot.contextGeneration },
      row.version,
      text
    )
    if (transport?.text && Buffer.byteLength(transport.text) > input.maxBytes) {
      throw new ConversationPreparationRowsRefusal('resource-limit')
    }
    const exported = await exportConversationContext({
      ...input,
      contextGeneration: input.snapshot.contextGeneration,
      sources: [
        {
          segmentId: row.segmentId,
          pinOwnerId: input.snapshot.ownerId,
          source: row.version.source,
          decision: 'include',
          critical: true
        }
      ],
      disclosure: {
        targetBindingDigest: input.targetBindingDigest,
        resolve: (source) =>
          conversationEvidenceKey({ source, sha256: row.version.sha256 }) ===
          conversationEvidenceKey(row.version)
            ? {
                version: row.version,
                contextGeneration: input.snapshot.contextGeneration,
                targetBindingDigest: input.targetBindingDigest,
                action: 'include',
                reason: 'user-policy',
                critical: true
              }
            : null
      }
    })
    yield {
      original: {
        version: row.version,
        text,
        byteLength: row.byteLength,
        artifactId: exported.artifact.ownerId,
        kind: 'historical-data',
        gaps: exported.gaps
      },
      representation: {
        version: row.version,
        representation: transport ? 'transport-projected' : 'exact',
        text,
        ...transport,
        artifactId: exported.artifact.ownerId,
        spans: transport ? [{ version: row.version, startByte: 0, endByte: row.byteLength }] : []
      }
    }
  }
}

export function createConversationPreparationRows(
  input: PreparationRowsInput & {
    projection: 'exact' | 'tools'
  }
) {
  let current: Awaited<
    ReturnType<NonNullable<ConversationPageEvidenceResolvers['resolveRequirement']>>
  > = null
  async function* rows(): AsyncGenerator<PreparationRow> {
    if (input.projection === 'exact') {
      yield* prepareConversationExactRows(input)
      return
    }
    try {
      for await (const row of readConversationPreparationSourceRows(
        input.db,
        input.snapshot.ownerId,
        input.signal
      )) {
        const projected =
          (await prepareConversationTransportSubmission(
            input.db,
            input.snapshot,
            row,
            input.signal
          )) ??
          (await projectConversationDisclosedRow(
            {
              version: row.version,
              byteLength: row.byteLength,
              artifactId: 'pending-export',
              chunks: checkConversationPreparationText(row.readChunks())
            },
            input.signal
          ))
        const transport =
          projected.original.text === undefined
            ? null
            : projectConversationTransportRow(
                input.db,
                {
                  conversationId: input.conversationId,
                  contextGeneration: input.snapshot.contextGeneration
                },
                row.version,
                projected.original.text
              )
        if (transport) {
          projected.projection = {
            ...projected.projection,
            ...transport,
            representation: 'transport-projected',
            spans: [{ version: row.version, startByte: 0, endByte: row.byteLength }]
          }
        }
        const text = projected.projection.text
        if (text === undefined) {
          throw new ConversationPreparationRowsRefusal('invalid-provenance')
        }
        const critical = transport !== null || canonicalSourceRequiresInline(text)
        if (
          critical &&
          projected.projection.representation !== 'exact' &&
          projected.projection.representation !== 'transport-projected'
        ) {
          throw new ConversationPreparationRowsRefusal('mandatory-not-inline')
        }
        if (Buffer.byteLength(text) > input.maxBytes) {
          throw new ConversationPreparationRowsRefusal('resource-limit')
        }
        const exported = await exportConversationContext({
          ...input,
          contextGeneration: input.snapshot.contextGeneration,
          sources: [
            {
              segmentId: row.segmentId,
              pinOwnerId: input.snapshot.ownerId,
              source: row.version.source,
              decision: 'include',
              critical
            }
          ],
          disclosure: {
            targetBindingDigest: input.targetBindingDigest,
            resolve: (source) =>
              conversationEvidenceKey({ source, sha256: row.version.sha256 }) ===
              conversationEvidenceKey(row.version)
                ? {
                    version: row.version,
                    contextGeneration: input.snapshot.contextGeneration,
                    targetBindingDigest: input.targetBindingDigest,
                    action: 'include',
                    reason: 'user-policy',
                    critical
                  }
                : null
          }
        })
        current =
          projected.projection.representation === 'summarized' && !critical
            ? {
                version: row.version,
                contextGeneration: input.snapshot.contextGeneration,
                sourceRevision: input.snapshot.sourceRevision,
                requirement: 'projection-approved'
              }
            : null
        yield {
          original: {
            ...projected.original,
            artifactId: exported.artifact.ownerId,
            gaps: exported.gaps
          },
          representation: { ...projected.projection, artifactId: exported.artifact.ownerId }
        }
        current = null
      }
    } catch (error) {
      if (error instanceof ConversationRowProjectionError) {
        throw new ConversationPreparationRowsRefusal(error.reason)
      }
      if (error instanceof ConversationExportError) {
        throw new ConversationPreparationRowsRefusal(error.code)
      }
      if (error instanceof Error && error.message === 'known-sensitive-source') {
        throw new ConversationPreparationRowsRefusal(error.message)
      }
      throw error
    } finally {
      current = null
    }
  }
  return {
    rows: rows(),
    verifyTransportProjection: (
      original: ConversationContextOriginal,
      part: ConversationContextRepresentation
    ) =>
      verifyConversationTransportProjection(
        input.db,
        {
          conversationId: input.conversationId,
          contextGeneration: input.snapshot.contextGeneration
        },
        part,
        original.text
      ),
    resolveRequirement: async (version: ConversationContextOriginal['version']) =>
      current && conversationEvidenceKey(version) === conversationEvidenceKey(current.version)
        ? current
        : null
  }
}
