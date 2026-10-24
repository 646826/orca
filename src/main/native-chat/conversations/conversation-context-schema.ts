import { z } from 'zod'

const positive = z.number().int().positive()
const text = z.string().min(1)
const source = z.object({
  sessionId: text,
  epoch: text,
  sequence: positive,
  itemId: text.optional(),
  itemRevision: z.number().int().nonnegative().optional(),
  batchIndex: z.number().int().nonnegative().optional()
})
const version = z.object({ source, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
const representation = z.enum([
  'exact',
  'transport-projected',
  'summarized',
  'retrievable-only',
  'missing'
])
const target = z.object({
  sessionId: text,
  provider: text,
  accountBindingDigest: text,
  nativeBindingGeneration: positive,
  capabilityFingerprint: text,
  model: text,
  retrieval: z.enum(['verified', 'unsupported'])
})
export const conversationManifestSchema = z.object({
  evidenceIndex: z
    .object({
      indexId: text,
      partCount: z.number().int().nonnegative(),
      rootDigest: z.string().regex(/^[a-f0-9]{64}$/)
    })
    .optional(),
  manifestId: text,
  digest: text,
  conversationId: text,
  contextGeneration: positive,
  sourceRevision: text,
  target,
  policy: z.enum(['full', 'budgeted', 'fresh']),
  projection: z.array(
    z.object({
      version,
      representation,
      text: z.string().optional(),
      artifactId: text.optional(),
      transportProjection: z
        .object({
          transfers: z
            .array(
              z
                .object({
                  transferId: text,
                  bodyPath: z.string().regex(/^\/(?:body|mutations\/(?:0|[1-9][0-9]*)\/body)$/),
                  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/)
                })
                .strict()
            )
            .min(1)
        })
        .strict()
        .optional(),
      spans: z.array(
        z.object({ version, startByte: z.number().int().nonnegative(), endByte: positive })
      )
    })
  ),
  mandatory: z.array(
    z.object({
      id: text,
      text,
      sources: z.array(version),
      supersedes: z.array(text),
      decodedFields: z
        .array(z.object({ version, jsonPointer: text, decodedSha256: text }))
        .optional()
    })
  ),
  gaps: z.array(
    z.object({
      source,
      reason: z.enum([
        'captured-incomplete',
        'legacy-bounded',
        'missing-artifact',
        'changed-artifact',
        'corrupt-source',
        'newer-schema',
        'unsupported-format',
        'excluded'
      ]),
      critical: z.boolean()
    })
  ),
  completeness: z.enum([
    'available-canonical',
    'available-canonical-with-gaps',
    'budgeted-projection',
    'fresh'
  ]),
  budget: z
    .object({
      capacity: z.number().nullable(),
      occupied: z.number().nullable(),
      reserved: z.number(),
      confidence: z.enum(['exact', 'upper-bound', 'unknown']),
      targetFingerprint: text,
      nativeBindingGeneration: positive,
      model: text,
      accountBindingDigest: text,
      observedAt: z.number().int(),
      validUntil: z.number().int()
    })
    .nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  inputTokenConfidence: z.enum(['exact', 'upper-bound', 'unknown']).optional(),
  targetBindingDigest: text,
  transformationsDigest: text,
  omissionsDigest: text
})
export const conversationCoverageSchema = z.object({
  manifestId: text,
  receiptId: text,
  targetSessionId: text,
  targetBindingDigest: text,
  contextGeneration: positive,
  nativeBindingGeneration: positive,
  version,
  representation,
  representationDigest: text
})

export function createConversationContextTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS conversation_context_manifests (
  manifest_id TEXT PRIMARY KEY,
  manifest_json TEXT NOT NULL,
  consent_json TEXT,
  preparation_evidence_json TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS conversation_manifest_immutable BEFORE UPDATE ON conversation_context_manifests
BEGIN SELECT RAISE(ABORT, 'context manifest is immutable'); END;
CREATE TRIGGER IF NOT EXISTS conversation_manifest_no_replace BEFORE INSERT ON conversation_context_manifests
WHEN EXISTS(SELECT 1 FROM conversation_context_manifests WHERE manifest_id=NEW.manifest_id)
BEGIN SELECT RAISE(ABORT, 'context manifest is immutable'); END;
CREATE TABLE IF NOT EXISTS conversation_context_coverage (
  target_session_id TEXT NOT NULL,
  target_binding_digest TEXT NOT NULL,
  context_generation INTEGER NOT NULL,
  native_binding_generation INTEGER NOT NULL,
  source_key TEXT NOT NULL,
  representation_digest TEXT NOT NULL,
  manifest_id TEXT NOT NULL REFERENCES conversation_context_manifests(manifest_id),
  record_json TEXT NOT NULL,
  PRIMARY KEY(target_session_id, target_binding_digest, context_generation, native_binding_generation, source_key, representation_digest)
);
`
}
