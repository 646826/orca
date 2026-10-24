import type { ConversationPreparationSourceRow } from './conversation-preparation-source-reader'
import { checkConversationPreparationText } from './conversation-preparation-sensitive'
import { createHash } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import type { ConversationSourceRef } from '../../../shared/conversation-record'
import {
  readConversationTransportSubmissionOriginal,
  type ConversationTransportScope
} from './conversation-transport-original'
import { projectConversationTransportRow } from './conversation-transport-projection'

/** Only an accepted host submission authorizes buffering its exact generated transport overhead. */
export function readConversationTransportSubmission(
  db: Database.Database,
  scope: ConversationTransportScope,
  source: ConversationSourceRef
) {
  const proof = readConversationTransportSubmissionOriginal(db, scope, source)
  if (!proof) {
    return null
  }
  const version = { source, sha256: createHash('sha256').update(proof.raw).digest('hex') }
  const projection = projectConversationTransportRow(db, scope, version, proof.raw)
  if (!projection?.text) {
    throw new Error('Transport submission projection is unavailable')
  }
  return {
    raw: proof.raw,
    rowByteLimit: proof.rowByteLimit,
    version,
    projection: { ...projection, text: projection.text }
  }
}

export async function prepareConversationTransportSubmission(
  db: Database.Database,
  scope: ConversationTransportScope,
  row: ConversationPreparationSourceRow,
  signal: AbortSignal
) {
  const authenticated = readConversationTransportSubmission(db, scope, row.version.source)
  if (!authenticated) {
    return null
  }
  for await (const _chunk of checkConversationPreparationText(row.readChunks())) {
    signal.throwIfAborted()
  }
  if (authenticated.version.sha256 !== row.version.sha256) {
    throw new Error('Transport submission canonical source changed')
  }
  return {
    original: {
      version: row.version,
      text: authenticated.raw,
      byteLength: row.byteLength,
      artifactId: 'pending-export',
      kind: 'historical-data' as const,
      gaps: []
    },
    projection: {
      version: row.version,
      ...authenticated.projection,
      representation: 'transport-projected' as const,
      artifactId: 'pending-export',
      spans: [{ version: row.version, startByte: 0, endByte: row.byteLength }]
    }
  }
}
