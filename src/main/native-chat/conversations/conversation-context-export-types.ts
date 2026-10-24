import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import type { ConversationSourceRef } from '../../../shared/conversation-record'
import type { ConversationEvidenceVersion } from '../../../shared/conversation-handoff'
export type ConversationExportSelection = {
  segmentId: string
  pinOwnerId: string
  source: ConversationSourceRef
  decision: 'include' | 'exclude'
  critical: boolean
}
export type ConversationExportedRow = {
  version: ConversationEvidenceVersion
  frameOffset: number
  byteOffset: number
  byteLength: number
  kind: JournalRow['kind']
  mutationCount: number
  substitutedValidationPaths: string[]
}
