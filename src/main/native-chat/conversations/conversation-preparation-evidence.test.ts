import { afterEach, expect, test } from 'vitest'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import {
  appendConversationManifestParts,
  createConversationManifestParts,
  sealConversationManifestParts
} from './conversation-context-parts'
import { readConversationPreparationEvidencePage } from './conversation-preparation-evidence'
import type {
  ConversationContextManifest,
  ConversationContextRepresentation
} from '../../../shared/conversation-handoff'
const fixtures: Awaited<ReturnType<typeof createConversationSwitchFixture>>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.close()
  }
})
test('indexed consent evidence pages every transformation and gap without exposing artifact paths', async () => {
  const f = await createConversationSwitchFixture()
  fixtures.push(f)
  const intent = f.records.conversations.intent(f.operationKey)!
  const id = createConversationManifestParts(f.host.db, {
    conversationId: intent.conversationId,
    contextGeneration: 1,
    sourceRevision: 'frozen'
  })
  const part = (sequence: number): ConversationContextRepresentation => ({
    version: {
      source: { sessionId: 'session-a', epoch: 'epoch-session-a', sequence },
      sha256: 'a'.repeat(64)
    },
    representation: 'retrievable-only',
    artifactId: '/private/local/path',
    spans: []
  })
  appendConversationManifestParts(
    f.host.db,
    id,
    0,
    [part(1), part(2)],
    [{ source: part(2).version.source, reason: 'captured-incomplete', critical: false }]
  )
  const index = await sealConversationManifestParts(f.host.db, id, new AbortController().signal)
  const manifest: ConversationContextManifest = {
    manifestId: 'm',
    digest: 'm',
    conversationId: intent.conversationId,
    contextGeneration: 1,
    sourceRevision: 'frozen',
    target: {
      sessionId: 'session-b',
      provider: 'codex',
      accountBindingDigest: 'account',
      nativeBindingGeneration: 1,
      capabilityFingerprint: 'caps',
      model: 'unknown',
      retrieval: 'verified'
    },
    policy: 'budgeted',
    projection: [],
    mandatory: [],
    gaps: [],
    completeness: 'budgeted-projection',
    budget: null,
    inputTokens: 0,
    targetBindingDigest: 'target',
    transformationsDigest: 'transform',
    omissionsDigest: 'omit',
    evidenceIndex: index
  }
  const first = readConversationPreparationEvidencePage(f.host.db, manifest, 0, 1)
  expect(first.complete).toBe(false)
  expect(first.entries).toHaveLength(1)
  const second = readConversationPreparationEvidencePage(f.host.db, manifest, first.next!, 1)
  expect(second.entries[0]?.gaps).toMatchObject([{ reason: 'captured-incomplete' }])
  expect(second.complete).toBe(true)
  expect(second.next).toBeNull()
  expect(JSON.stringify([first, second])).not.toContain('/private/local/path')
  expect(second.manifestDigest).toBe(manifest.digest)
  expect(manifest.gaps).toHaveLength(0)
})
