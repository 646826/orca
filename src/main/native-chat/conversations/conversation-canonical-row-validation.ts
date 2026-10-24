import { createHash } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import type { ConversationSourceRef } from '../../../shared/conversation-record'
import type { ConversationTransportScope } from './conversation-transport-original'
import { readConversationTransportSubmission } from './conversation-transport-submission'
import { createConversationContextRowValidator } from './conversation-context-row-validation'
import { ConversationExportError } from './conversation-export-error'

/** Structural validation may remove only authenticated transport; integrity still covers raw bytes. */
export function createConversationCanonicalRowValidator(
  db: Database.Database,
  scope: ConversationTransportScope,
  source: ConversationSourceRef,
  byteLength: number
) {
  const transport = readConversationTransportSubmission(db, scope, source)
  if (!transport) {
    return createConversationContextRowValidator({ byteLength })
  }
  if (Buffer.byteLength(transport.raw) !== byteLength) {
    throw new ConversationExportError('corrupt-source')
  }
  const projected = transport.projection.text
  const validator = createConversationContextRowValidator({
    byteLength: Buffer.byteLength(projected)
  })
  const hash = createHash('sha256')
  let bytes = 0
  return {
    write(text: string) {
      bytes += Buffer.byteLength(text)
      if (bytes > byteLength) {
        throw new ConversationExportError('corrupt-source')
      }
      hash.update(text)
    },
    end() {
      if (bytes !== byteLength || hash.digest('hex') !== transport.version.sha256) {
        throw new ConversationExportError('corrupt-source')
      }
      validator.write(projected)
      return validator.end()
    }
  }
}
