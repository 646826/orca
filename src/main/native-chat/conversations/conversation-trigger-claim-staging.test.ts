import { expect, it } from 'vitest'
import { triggerClaimsFixture } from './conversation-trigger-claims.test-fixture'
import { stageConversationTriggerClaims } from './conversation-trigger-claim-staging'
import { prepareConversationTrigger } from './conversation-trigger-claims'
import { readConversationTriggerAttachments } from './conversation-trigger-attachments'

it('requires nonempty uploads to be staged before final reservation', async () => {
  const fixture = await triggerClaimsFixture(async (_directory, storeFile) => {
    const path = await storeFile('evidence.txt', 'managed trigger evidence')
    return { kind: 'message', role: 'user', blocks: [{ type: 'text', text: path }] }
  })
  const signal = new AbortController().signal
  await expect(
    prepareConversationTrigger(fixture.db, fixture.request, fixture.claimsHost, 1, signal)
  ).rejects.toThrow('must be staged')
  const staged = await stageConversationTriggerClaims(
    fixture.db,
    {
      ...fixture.request,
      expectedIntentVersion: fixture.intent.version,
      stateDirectory: fixture.claimsHost.stateDirectory
    },
    1,
    signal,
    fixture.deliveryHost.getJournal
  )
  expect(readConversationTriggerAttachments(fixture.db, fixture.request.transferId)).toHaveLength(1)
  const prepared = await prepareConversationTrigger(
    fixture.db,
    fixture.request,
    fixture.claimsHost,
    1,
    signal
  )
  expect(prepared.binding.attachmentClaimsDigest).toBe(staged.attachmentClaimsDigest)
})
