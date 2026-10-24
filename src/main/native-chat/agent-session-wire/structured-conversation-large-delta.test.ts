import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { CALLER } from './structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import { createCodexConversationRoundtripFixture } from './structured-conversation-roundtrip.test-fixture'
import type { ConversationSwitchIntent } from '../../../shared/conversation-record'
import { conversationManifestSchema } from '../conversations/conversation-context-schema'
import { conversationContextDigest } from '../conversations/conversation-context-consent'
import { readConversationManifestParts } from '../conversations/conversation-context-parts'
import { hasConversationRepresentationCoverage } from '../conversations/conversation-context-index-delta'
import { readConversationNativeIdentity } from '../conversations/conversation-origin-native-identity'
import { parseJournalRow } from '../agent-session-journal/journal-row-schema'
import { conversationCanonicalRowBodies } from '../conversations/conversation-canonical-row'
import { conversationContextEnvelope } from '../conversations/conversation-context-envelope'

const batch = (name: string) =>
  Array.from({ length: 17 }, (_, index) => `${name}-${index}\n`.padEnd(32 * 1024, 'x'))

it('delivers a tiny verified revisit delta after actual native acceptance of more than 1 MiB of distinct assistant history', async () => {
  const f = await createCodexConversationRoundtripFixture()
  const { host, db, signal, targetId } = f
  const activate = async (
    intent: ConversationSwitchIntent,
    source: string,
    target: string,
    response: string | readonly string[],
    inspect?: (manifestId: string) => void
  ) => {
    expect(
      await f.send(source, 'Continue with every original instruction retained.', true)
    ).toMatchObject({ ok: true })
    f.approve(host.deps.store.conversations.intent(intent.operationKey)!)
    expect(await host.advanceConversationSwitch(intent.operationKey, signal)).toEqual({
      kind: 'waiting-consent'
    })
    const preview = host.deps.conversationPreparationControls!.read(intent.operationKey)!.preview!
    inspect?.(preview.manifestDigest)
    f.consent(intent)
    const pending = host.advanceConversationSwitch(intent.operationKey, signal)
    const wire = await f.acceptNative(target, response)
    expect(await pending).toMatchObject({ kind: 'activated' })
    const activated = host.deps.store.conversations.intent(intent.operationKey)!
    expect(activated.deliveryReceiptId).not.toBeNull()
    expect(
      db
        .prepare('SELECT 1 FROM conversation_context_index_receipts WHERE manifest_id=?')
        .get(activated.manifestId)
    ).toBeDefined()
    return wire
  }
  try {
    await f.enrollSource()
    const initial = f.send(
      HOST_TEST_SESSION,
      'Never upload private files. Preserve the original decision.'
    )
    await f.acceptNative(HOST_TEST_SESSION, batch('A-original'))
    expect(await initial).toMatchObject({ ok: true })
    const first = await f.foundTarget(HOST_TEST_SESSION, targetId, {
      options: { model: 'gpt-live' }
    })
    await expect(host.advanceConversationSwitch(first.operationKey, signal)).rejects.toThrow(
      'Candidate native acquisition refused'
    )
    const trust = host.deps.conversationEvidenceTrust!.read(first.operationKey)!
    host.deps.conversationEvidenceTrust!.approve(
      { operationKey: first.operationKey, choiceDigest: trust.choiceDigest },
      CALLER.callerKey
    )
    expect(await host.advanceConversationSwitch(first.operationKey, signal)).toMatchObject({
      kind: 'blocked',
      reasons: ['recipient-approval-required']
    })
    await activate(first, HOST_TEST_SESSION, targetId, batch('B-original'))
    await activate(
      await f.beginReturn(targetId, HOST_TEST_SESSION),
      targetId,
      HOST_TEST_SESSION,
      batch('A-second')
    )
    await activate(
      await f.beginReturn(HOST_TEST_SESSION, targetId),
      HOST_TEST_SESSION,
      targetId,
      batch('B-second')
    )
    await activate(
      await f.beginReturn(targetId, HOST_TEST_SESSION),
      targetId,
      HOST_TEST_SESSION,
      'Only a tiny new response.'
    )
    let expectedEnvelope = ''
    let evidence: Record<string, string | number> = {}
    const finalWire = await activate(
      await f.beginReturn(HOST_TEST_SESSION, targetId),
      HOST_TEST_SESSION,
      targetId,
      'Tiny delta accepted.',
      (manifestId) => {
        const raw = db
          .prepare(
            'SELECT manifest_json FROM conversation_preparation_previews WHERE manifest_id=?'
          )
          .get(manifestId)?.manifest_json
        if (typeof raw !== 'string' || !host.deps.conversationDeliveryHost) {
          throw new Error('Real preview authority unavailable')
        }
        const manifest = conversationManifestSchema.parse(JSON.parse(raw))
        expect(manifest.inputTokens).toBeNull()
        expect(manifest.inputTokenConfidence).toBe('unknown')
        expect(
          db
            .prepare('SELECT 1 FROM conversation_context_index_receipts WHERE manifest_id=?')
            .get(manifestId)
        ).toBeUndefined()
        const nativeIdentityDigest = host.deps.conversationDeliveryHost.readPreparationEvidence(
          db,
          manifest
        )?.nativeIdentityDigest
        if (!nativeIdentityDigest) {
          throw new Error('Real native preparation witness missing')
        }
        expect(nativeIdentityDigest).toBe(readConversationNativeIdentity(db, targetId))
        const selected = new Set(
          manifest.projection.map((part) => conversationContextDigest(part.version))
        )
        const skippedAssistantTexts = new Set<string>()
        let skipped = 0,
          after = 0,
          retainedCanonicalBytes = 0
        if (!manifest.evidenceIndex) {
          throw new Error('Real sealed index missing')
        }
        while (after < manifest.evidenceIndex.partCount) {
          const parts = readConversationManifestParts(
            db,
            manifest.evidenceIndex.indexId,
            after,
            128
          )
          expect(parts.length).toBeGreaterThan(0)
          for (const { ordinal, part } of parts) {
            after = ordinal
            const source = part.version.source
            const canonical = db
              .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?')
              .get(source.sessionId, source.epoch, source.sequence)?.row_json
            if (typeof canonical !== 'string') {
              throw new Error('Retained original missing')
            }
            retainedCanonicalBytes += Buffer.byteLength(canonical)
            expect(createHash('sha256').update(canonical).digest('hex')).toBe(part.version.sha256)
            const parsed = parseJournalRow(canonical)
            if (!parsed.ok) {
              throw new Error('Retained original invalid')
            }
            for (const body of conversationCanonicalRowBodies(parsed.row)) {
              if (
                source.sessionId === HOST_TEST_SESSION &&
                !selected.has(conversationContextDigest(part.version)) &&
                body.kind === 'message' &&
                body.role === 'assistant'
              ) {
                for (const block of body.blocks) {
                  if (block.type === 'text') {
                    skippedAssistantTexts.add(block.text)
                  }
                }
              }
            }
            if (!selected.has(conversationContextDigest(part.version))) {
              skipped++
              expect(
                hasConversationRepresentationCoverage(
                  db,
                  { ...manifest, nativeIdentityDigest },
                  part
                )
              ).toBe(true)
              expect(part.representation).not.toBe('transport-projected')
            } else if (part.representation === 'transport-projected') {
              expect(part.text).not.toContain('historicalEvidence')
            }
          }
        }
        const omittedOriginalAssistantBytes = [...skippedAssistantTexts].reduce(
          (sum, text) => sum + Buffer.byteLength(text),
          0
        )
        expect(omittedOriginalAssistantBytes).toBeGreaterThan(1024 * 1024)
        expect(skipped).toBeGreaterThan(0)
        expectedEnvelope = conversationContextEnvelope(manifest)
        expect(Buffer.byteLength(expectedEnvelope)).toBeLessThan(64 * 1024)
        expect(expectedEnvelope).toContain('Never upload private files.')
        expect(expectedEnvelope).toContain('Only a tiny new response.')
        expect(expectedEnvelope).not.toContain('A-original-0')
        expect(expectedEnvelope).not.toContain('A-second-0')
        evidence = {
          retainedCanonicalBytes,
          indexedParts: manifest.evidenceIndex.partCount,
          verifiedOmittedParts: skipped,
          omittedOriginalAssistantBytes,
          outgoingEnvelopeBytes: Buffer.byteLength(expectedEnvelope),
          indexRootDigest: manifest.evidenceIndex.rootDigest,
          nativeIdentityDigest
        }
      }
    )
    const wire = z
      .object({ input: z.array(z.object({ type: z.literal('text'), text: z.string() })) })
      .parse(finalWire)
    expect(wire.input[0]?.text).toBe(expectedEnvelope)
    expect(f.codex.connections).toHaveLength(2)
    expect(
      f.codex.connections.flatMap((connection) =>
        connection.calls.filter((call) => call.method === 'thread/start')
      )
    ).toHaveLength(2)
    expect(
      f.codex.connections.flatMap((connection) =>
        connection.calls.filter((call) => call.method === 'turn/start')
      )
    ).toHaveLength(6)
    for (const sessionId of [HOST_TEST_SESSION, targetId]) {
      expect(
        host
          .collaboratorsForTests()
          .sessions.get(sessionId)!
          .journal.submissions()
          .map((submission) => submission.dispatchState)
      ).toEqual(['accepted', 'accepted', 'accepted'])
    }
    console.info('conversation-large-delta-evidence', JSON.stringify(evidence))
  } finally {
    await f.close()
  }
}, 120_000)
