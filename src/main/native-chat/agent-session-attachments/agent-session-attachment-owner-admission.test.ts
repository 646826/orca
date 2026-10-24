import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createConversationSwitchFixture } from '../conversations/conversation-switch.fixture'
import { createAgentSessionUploadOwnership } from './agent-session-upload-provenance'
import { agentSessionAttachmentStoreRoot } from './agent-session-attachment-references'
import { claimAgentSessionAttachmentsInTransaction } from './agent-session-attachment-claims'

const uploadId = '13defd20-7682-4d10-91a4-1da298d0ca60'
test('new user claims require actual upload origin, and current conversation participants can share it', async () => {
  const f = await createConversationSwitchFixture()
  try {
    const directory = join(agentSessionAttachmentStoreRoot(f.host.stateDirectory), uploadId)
    mkdirSync(directory, { recursive: true })
    const path = join(directory, 'image.png')
    writeFileSync(path, 'image bytes')
    const claim = (sessionId: string, required = true) =>
      f.host.transaction((db) =>
        claimAgentSessionAttachmentsInTransaction(db, {
          sessionId,
          stateDirectory: f.host.stateDirectory,
          required,
          now: Date.now(),
          body: { kind: 'message', role: 'user', blocks: [{ type: 'image-ref', path }] }
        })
      )
    expect(() => claim('session-a')).toThrow()
    expect(
      f.host.db
        .prepare('SELECT 1 FROM agent_session_attachment_claims WHERE upload_id=?')
        .get(uploadId)
    ).toBeUndefined()
    const ownership = createAgentSessionUploadOwnership(() => f.host.db)
    const owner = ownership.capture('session-a')
    ownership.begin({ uploadId, name: 'image.png', byteLength: 11, owner })
    ownership.commit(uploadId, owner)
    claim('session-b')
    expect(
      f.host.db
        .prepare('SELECT 1 FROM agent_session_attachment_claims WHERE upload_id=? AND session_id=?')
        .get(uploadId, 'session-b')
    ).toBeDefined()
    expect(() => claim('foreign-session')).toThrow()
    // Reading/restoring captured legacy history does not acquire new user-send authority.
    expect(() => claim('historical-session', false)).not.toThrow()
  } finally {
    f.close()
  }
})
