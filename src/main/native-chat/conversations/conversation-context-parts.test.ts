import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { openJournalDatabase } from '../agent-session-journal/journal-database'
import {
  appendConversationManifestParts,
  createConversationManifestParts,
  readConversationManifestParts,
  sealConversationManifestParts
} from './conversation-context-parts'
import type { ConversationContextRepresentation } from '../../../shared/conversation-handoff'
let db: Database.Database, root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-parts-'))
  db = openJournalDatabase(join(root, 'db')).db
})
afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})
const part = (sequence: number): ConversationContextRepresentation => ({
  version: { source: { sessionId: 'a', epoch: 'e', sequence }, sha256: 'a'.repeat(64) },
  representation: 'retrievable-only',
  artifactId: 'archive',
  spans: []
})
it('pages immutable parts, binds all entries in a sealed digest and refuses late appends', async () => {
  const id = createConversationManifestParts(db, {
    conversationId: 'c',
    contextGeneration: 1,
    sourceRevision: 'revision'
  })
  appendConversationManifestParts(db, id, 0, [part(1), part(2)])
  expect(readConversationManifestParts(db, id, 0, 1)).toEqual([
    { ordinal: 1, part: part(1), gaps: [] }
  ])
  const index = await sealConversationManifestParts(db, id, new AbortController().signal)
  expect(index.partCount).toBe(2)
  expect(index.rootDigest).toMatch(/^[a-f0-9]{64}$/)
  expect(() => appendConversationManifestParts(db, id, 2, [part(3)])).toThrow()
  expect(() => db.prepare('UPDATE conversation_manifest_parts SET part_json=?').run('{}')).toThrow()
})
it('rejects duplicate source versions, stale append cursors, oversized pages and cancelled sealing', async () => {
  const id = createConversationManifestParts(db, {
    conversationId: 'c',
    contextGeneration: 1,
    sourceRevision: 'revision'
  })
  appendConversationManifestParts(db, id, 0, [part(1)])
  expect(() => appendConversationManifestParts(db, id, 0, [part(2)])).toThrow()
  expect(() => appendConversationManifestParts(db, id, 1, [part(1)])).toThrow()
  expect(() =>
    appendConversationManifestParts(
      db,
      id,
      1,
      Array.from({ length: 129 }, (_, i) => part(i + 2))
    )
  ).toThrow()
  const controller = new AbortController()
  controller.abort()
  await expect(sealConversationManifestParts(db, id, controller.signal)).rejects.toThrow()
  expect(readConversationManifestParts(db, id, 0, 128)).toHaveLength(1)
})
it('bounds reads by encoded bytes even when small append calls accumulate large parts', () => {
  const id = createConversationManifestParts(db, {
    conversationId: 'c',
    contextGeneration: 1,
    sourceRevision: 'revision'
  })
  for (let i = 0; i < 5; i++) {
    appendConversationManifestParts(db, id, i, [
      { ...part(i + 1), representation: 'exact', text: 'x'.repeat(700000) }
    ])
  }
  const page = readConversationManifestParts(db, id, 0, 128)
  expect(page.length).toBeGreaterThan(0)
  expect(page.length).toBeLessThan(5)
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(2 * 1024 * 1024)
})
