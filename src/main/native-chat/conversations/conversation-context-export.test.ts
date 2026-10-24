import {
  createConversationExportDisclosureTablesSql,
  readConversationExportDisclosure
} from './conversation-source-disclosure'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { runJournalTransaction } from '../agent-session-journal/journal-database'
import {
  prepareConversationSourceAtomReceipt,
  createConversationSourceAtomTablesSql
} from './conversation-source-atoms'
import {
  createConversationExportProofTablesSql,
  readConversationExportProof
} from './conversation-context-export-proof'
import { createConversationTablesSql } from './conversation-schema'
import { createConversationTriggerTablesSql } from './conversation-trigger-schema'
import { ensureQueuedMessagesTable } from '../agent-session-journal/queued-message-schema'
import { createJournalEpochPinTablesSql } from '../agent-session-journal/journal-epoch-pins'
import { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import { ensureAgentSessionAttachmentClaimTables } from '../agent-session-attachments/agent-session-attachment-claims'
import { ensureConversationAttachmentClaimTables } from '../agent-session-attachments/conversation-attachment-claims'
import {
  streamConversationExportRows,
  exportConversationContext
} from './conversation-context-export'
let root: string, db: Database.Database, store: AgentSessionAttachmentStore
const raw = JSON.stringify({
  v: 3,
  epoch: 'epoch',
  seq: 1,
  fence: 1,
  ts: 1,
  kind: 'item',
  itemId: 'message',
  revision: 1,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: '甲🙂 final constraint' }] }
})
const selection = {
  segmentId: 'segment',
  pinOwnerId: 'pin',
  source: { sessionId: 'session', epoch: 'epoch', sequence: 1 },
  decision: 'include' as const,
  critical: true
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-export-'))
  db = new Database(':memory:')
  db.exec(createConversationTablesSql())
  ensureQueuedMessagesTable(db)
  db.exec(createConversationTriggerTablesSql())
  db.exec(createConversationSourceAtomTablesSql())
  db.exec(
    'CREATE TABLE journal_rows(session_id TEXT,epoch TEXT,seq INTEGER,row_json TEXT,PRIMARY KEY(session_id,epoch,seq))'
  )
  db.exec('CREATE TABLE journal_sessions(session_id TEXT,epoch TEXT)')
  db.exec(createJournalEpochPinTablesSql())
  ensureAgentSessionAttachmentClaimTables(db)
  ensureConversationAttachmentClaimTables(db)
  db.exec(createConversationExportProofTablesSql())
  db.exec(createConversationExportDisclosureTablesSql())
  db.prepare('INSERT INTO conversations VALUES(?,?)').run(
    'chat',
    JSON.stringify({
      conversationId: 'chat',
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'folder',
        workspaceKind: 'folder'
      },
      revision: 1,
      contextGeneration: 1,
      activationFence: 1,
      activeSegmentId: 'segment',
      pendingOperationKey: null
    })
  )
  db.prepare('INSERT INTO conversation_segments VALUES(?,?,?,?)').run(
    'segment',
    'chat',
    1,
    JSON.stringify({
      segmentId: 'segment',
      conversationId: 'chat',
      ordinal: 1,
      sessionId: 'session',
      contextGeneration: 1,
      activationFence: 1,
      nativeBindingGeneration: 1,
      startSequence: 1,
      boundary: { sessionId: 'session', epoch: 'epoch', endSequence: 1 }
    })
  )
  db.prepare('INSERT INTO journal_rows VALUES(?,?,?,?)').run('session', 'epoch', 1, raw)
  db.prepare('INSERT INTO journal_epoch_pins VALUES(?,?,?,?)').run('pin', 'session', 'epoch', 1)
  db.prepare('INSERT INTO conversation_source_attribution VALUES(?,?,?,?)').run(
    'session',
    'epoch',
    1,
    'segment'
  )
  store = new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(root), {
    hasSession: () => true
  })
})
afterEach(async () => {
  db.close()
  await rm(root, { recursive: true, force: true })
})
function fixtureDigest(source: typeof selection.source): string {
  const value = db
    .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?')
    .get(source.sessionId, source.epoch, source.sequence)?.row_json
  if (typeof value !== 'string' && !(value instanceof Uint8Array)) {
    throw new Error('Invalid fixture')
  }
  return createHash('sha256').update(value).digest('hex')
}
const request = () => ({
  db,
  stateDirectory: root,
  store,
  conversationId: 'chat',
  contextGeneration: 1,
  sources: [selection],
  disclosure: {
    targetBindingDigest: 'a'.repeat(64),
    resolve: (source: typeof selection.source) => ({
      version: {
        source,
        sha256: fixtureDigest(source)
      },
      contextGeneration: 1,
      targetBindingDigest: 'a'.repeat(64),
      action: 'include' as const,
      reason: 'user-policy' as const,
      critical: true
    })
  }
})
it('exports exact host-local canonical UTF8 with source digest and frozen row offsets', async () => {
  const result = await exportConversationContext(request())
  const bytes = await readFile(result.artifact.path)
  expect(
    bytes
      .subarray(result.rows[0]!.byteOffset, result.rows[0]!.byteOffset + result.rows[0]!.byteLength)
      .toString()
  ).toBe(raw)
  expect(result.rows[0]!.version.sha256).toBe(createHash('sha256').update(raw).digest('hex'))
  expect(result.gaps).toEqual([])
})
it('excludes source bytes before publication and records the critical gap', async () => {
  const result = await exportConversationContext({
    ...request(),
    sources: [{ ...selection, decision: 'exclude' }]
  })
  expect((await readFile(result.artifact.path, 'utf8')).includes('final constraint')).toBe(false)
  expect(result.gaps).toMatchObject([{ reason: 'excluded', critical: true }])
})
it('rejects wrong generation, absent pins, or attribution belonging to another segment', async () => {
  await expect(
    exportConversationContext({ ...request(), contextGeneration: 2 })
  ).rejects.toMatchObject({ code: 'scope' })
  await expect(
    exportConversationContext({ ...request(), sources: [{ ...selection, pinOwnerId: 'missing' }] })
  ).rejects.toMatchObject({ code: 'missing-source' })
  db.prepare('DELETE FROM conversation_source_attribution').run()
  await expect(exportConversationContext(request())).rejects.toMatchObject({ code: 'scope' })
  expect(db.prepare('SELECT count(*) n FROM conversation_attachment_claims').get()?.n).toBe(0)
})
it('refuses oversized inline rows without deleting or clipping retained evidence', async () => {
  db.prepare('DELETE FROM journal_epoch_pins').run()
  db.prepare('UPDATE journal_rows SET row_json=zeroblob(?)').run(65 * 1024 * 1024)
  db.prepare('INSERT INTO journal_epoch_pins VALUES(?,?,?,?)').run('pin', 'session', 'epoch', 1)
  await expect(exportConversationContext(request())).rejects.toMatchObject({
    code: 'resource-limit'
  })
  expect(db.prepare('SELECT octet_length(row_json) n FROM journal_rows').get()?.n).toBe(
    65 * 1024 * 1024
  )
})
it('does not publish aborted or corrupt exports', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(
    exportConversationContext({ ...request(), signal: controller.signal })
  ).rejects.toThrow()
  db.prepare('DELETE FROM journal_epoch_pins').run()
  db.prepare('UPDATE journal_rows SET row_json=?').run('{broken')
  db.prepare('INSERT INTO journal_epoch_pins VALUES(?,?,?,?)').run('pin', 'session', 'epoch', 1)
  await expect(exportConversationContext(request())).rejects.toThrow()
  expect(db.prepare('SELECT count(*) n FROM conversation_attachment_claims').get()?.n).toBe(0)
})

it('holds an independent read pin when the initiating owner disappears during an await', async () => {
  db.prepare('INSERT INTO journal_sessions VALUES(?,?)').run('session', 'epoch')
  let protectedFromRewrite = false
  const timer = setTimeout(() => {
    db.prepare('DELETE FROM journal_epoch_pins WHERE owner_id=?').run('pin')
    try {
      db.prepare('UPDATE journal_rows SET row_json=?').run('{}')
    } catch {
      protectedFromRewrite = true
    }
  }, 0)
  await expect(exportConversationContext(request())).rejects.toMatchObject({
    code: 'missing-source'
  })
  clearTimeout(timer)
  expect(protectedFromRewrite).toBe(true)
  expect(db.prepare('SELECT row_json FROM journal_rows').get()?.row_json).toBe(raw)
  expect(db.prepare('SELECT count(*) n FROM conversation_attachment_claims').get()?.n).toBe(0)
})
it('reports known captured truncation and rejects invalid UTF8 without a published artifact', async () => {
  db.prepare('DELETE FROM journal_epoch_pins').run()
  const tool = JSON.stringify({
    v: 3,
    epoch: 'epoch',
    seq: 1,
    fence: 1,
    ts: 1,
    kind: 'item',
    itemId: 'tool',
    revision: 1,
    body: {
      kind: 'tool-call',
      name: 'shell',
      state: 'done',
      output: { head: 'preview', byteLength: 100000, digest: 'not-recovery', truncated: true }
    }
  })
  db.prepare('UPDATE journal_rows SET row_json=?').run(tool)
  db.prepare('INSERT INTO journal_epoch_pins VALUES(?,?,?,?)').run('pin', 'session', 'epoch', 1)
  const result = await exportConversationContext(request())
  expect(result.gaps).toMatchObject([{ reason: 'captured-incomplete', critical: true }])
  db.prepare('DELETE FROM journal_epoch_pins').run()
  db.prepare('UPDATE journal_rows SET row_json=?').run(Buffer.from([0xff]))
  db.prepare('INSERT INTO journal_epoch_pins VALUES(?,?,?,?)').run('pin', 'session', 'epoch', 1)
  await expect(exportConversationContext(request())).rejects.toMatchObject({
    code: 'corrupt-source'
  })
})
it('does not disclose lifecycle siblings on row-level authority alone', async () => {
  db.prepare('DELETE FROM journal_epoch_pins').run()
  db.prepare('UPDATE journal_rows SET row_json=?').run(
    JSON.stringify({
      v: 3,
      epoch: 'epoch',
      seq: 1,
      fence: 1,
      ts: 1,
      kind: 'lifecycle-batch',
      settlementId: 'settle',
      mutations: [
        {
          kind: 'item',
          itemId: 'old-generation',
          revision: 1,
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'excluded sibling' }]
          }
        }
      ]
    })
  )
  db.prepare('INSERT INTO journal_epoch_pins VALUES(?,?,?,?)').run('pin', 'session', 'epoch', 1)
  await expect(exportConversationContext(request())).rejects.toMatchObject({ code: 'scope' })
  expect(db.prepare('SELECT count(*) n FROM conversation_attachment_claims').get()?.n).toBe(0)
  const origin = {
    conversationId: 'chat',
    segmentId: 'segment',
    sessionId: 'session',
    contextGeneration: 1,
    nativeBindingGeneration: 1
  }
  const receipt = prepareConversationSourceAtomReceipt(db, {
    pin: { ownerId: 'pin', sessionId: 'session', epoch: 'epoch', endSequence: 1 },
    source: selection.source,
    envelopeOrigin: origin,
    mutationOrigins: [{ batchIndex: 0, origin }]
  })
  runJournalTransaction(db, () => receipt.write(db, undefined))
  const authorized = await exportConversationContext(request())
  expect(authorized.rows[0]?.mutationCount).toBe(1)
})
it('streams claimed row slices with integrity and refuses forged hashes or revoked claims', async () => {
  const result = await exportConversationContext(request())
  const read = async (rows = result.rows) => {
    let text = ''
    for await (const entry of streamConversationExportRows({
      ...request(),
      artifact: result.artifact,
      rows
    })) {
      const decoder = new TextDecoder()
      for await (const chunk of entry.chunks) {
        text += decoder.decode(chunk, { stream: true })
      }
      text += decoder.decode()
    }
    return text
  }
  expect(await read()).toBe(raw)
  const first = result.rows[0]!
  await expect(
    read([
      {
        ...first,
        version: { ...first.version, source: { ...first.version.source, sessionId: 'forged' } }
      }
    ])
  ).rejects.toMatchObject({ code: 'scope' })
  await expect(
    read([{ ...first, version: { ...first.version, sha256: '0'.repeat(64) } }])
  ).rejects.toMatchObject({ code: 'scope' })
  db.prepare('DELETE FROM conversation_attachment_claims WHERE owner_id=?').run(
    result.artifact.ownerId
  )
  await expect(read()).rejects.toMatchObject({ code: 'scope' })
})
it('refuses conflicting duplicate disclosure selections instead of leaking excluded bytes', async () => {
  await expect(
    exportConversationContext({
      ...request(),
      sources: [selection, { ...selection, decision: 'exclude' }]
    })
  ).rejects.toMatchObject({ code: 'scope' })
  expect(db.prepare('SELECT count(*) n FROM conversation_attachment_claims').get()?.n).toBe(0)
})
it('persists immutable artifact range proof and removes it with explicit claim release', async () => {
  const result = await exportConversationContext(request())
  const row = result.rows[0]!
  const lookup = () =>
    readConversationExportProof(db, {
      ownerId: result.artifact.ownerId,
      conversationId: 'chat',
      contextGeneration: 1,
      version: row.version
    })
  expect(lookup()).toMatchObject({
    artifactVersion: result.artifact.version,
    frameOffset: row.frameOffset,
    byteOffset: row.byteOffset,
    byteLength: row.byteLength
  })
  expect(
    readConversationExportProof(db, {
      ownerId: result.artifact.ownerId,
      conversationId: 'chat',
      contextGeneration: 2,
      version: row.version
    })
  ).toBeNull()
  expect(() => db.prepare('UPDATE conversation_export_sources SET byte_offset=0').run()).toThrow()
  db.prepare('DELETE FROM conversation_attachment_claims WHERE owner_id=?').run(
    result.artifact.ownerId
  )
  expect(lookup()).toBeNull()
  expect(db.prepare('SELECT count(*) n FROM conversation_export_sources').get()?.n).toBe(0)
})
it('rolls back artifact claims and source proofs when publication fails', async () => {
  db.exec(
    "CREATE TRIGGER fail_export_proof BEFORE INSERT ON conversation_export_sources BEGIN SELECT RAISE(ABORT,'fixture proof write failed'); END"
  )
  await expect(exportConversationContext(request())).rejects.toThrow('fixture proof write failed')
  expect(db.prepare('SELECT count(*) n FROM conversation_attachment_claims').get()?.n).toBe(0)
  expect(db.prepare('SELECT count(*) n FROM conversation_export_sources').get()?.n).toBe(0)
  expect(db.prepare('SELECT count(*) n FROM conversation_source_versions').get()?.n).toBe(0)
  expect(db.prepare('SELECT row_json FROM journal_rows').get()?.row_json).toBe(raw)
})

it('denies export without host disclosure authority', async () => {
  await expect(
    exportConversationContext({ ...request(), disclosure: undefined })
  ).rejects.toMatchObject({ code: 'scope' })
})

it('excludes host-known sensitive bytes despite requested inclusion and binds the proof to target', async () => {
  const requestInput = request()
  const fact = requestInput.disclosure.resolve(selection.source)
  const result = await exportConversationContext({
    ...requestInput,
    disclosure: {
      targetBindingDigest: fact.targetBindingDigest,
      resolve: () => ({ ...fact, action: 'exclude', reason: 'known-sensitive' })
    }
  })
  expect(await readFile(result.artifact.path, 'utf8')).toBe('')
  expect(result.gaps).toEqual([{ source: selection.source, reason: 'excluded', critical: true }])
  expect(db.prepare('SELECT row_json FROM journal_rows').get()?.row_json).toBe(raw)
  const lookup = {
    ownerId: result.artifact.ownerId,
    conversationId: 'chat',
    contextGeneration: 1,
    targetBindingDigest: fact.targetBindingDigest,
    version: fact.version
  }
  expect(readConversationExportDisclosure(db, lookup)?.action).toBe('exclude')
  expect(
    readConversationExportDisclosure(db, { ...lookup, targetBindingDigest: 'b'.repeat(64) })
  ).toBeNull()
})
it('rejects stale host source versions and unbounded publication pages', async () => {
  const input = request()
  const fact = input.disclosure.resolve(selection.source)
  await expect(
    exportConversationContext({
      ...input,
      disclosure: {
        targetBindingDigest: fact.targetBindingDigest,
        resolve: () => ({ ...fact, version: { ...fact.version, sha256: 'b'.repeat(64) } })
      }
    })
  ).rejects.toMatchObject({ code: 'corrupt-source' })
  await expect(
    exportConversationContext({ ...input, sources: Array.from({ length: 257 }, () => selection) })
  ).rejects.toMatchObject({ code: 'resource-limit' })
  expect(db.prepare('SELECT count(*) n FROM conversation_attachment_claims').get()?.n).toBe(0)
})
it('refuses target identity drift during export and a reader without durable source proof', async () => {
  const input = request(),
    fact = input.disclosure.resolve(selection.source)
  let calls = 0
  const disclosure = {
    targetBindingDigest: fact.targetBindingDigest,
    resolve: () => {
      if (++calls > 1) {
        disclosure.targetBindingDigest = 'b'.repeat(64)
      }
      return { ...fact, targetBindingDigest: disclosure.targetBindingDigest }
    }
  }
  await expect(exportConversationContext({ ...input, disclosure })).rejects.toMatchObject({
    code: 'scope'
  })
  const exported = await exportConversationContext(request())
  db.prepare('DELETE FROM conversation_export_sources').run()
  const read = async () => {
    for await (const entry of streamConversationExportRows({ ...request(), ...exported })) {
      for await (const chunk of entry.chunks) {
        expect(chunk.length).toBeGreaterThan(0)
      }
    }
  }
  await expect(read()).rejects.toMatchObject({ code: 'scope' })
})
it('preserves host-critical captured gaps even when the requested selection is noncritical', async () => {
  const bounded = JSON.stringify({
    ...JSON.parse(raw),
    body: {
      kind: 'tool-call',
      name: 'shell',
      state: 'done',
      output: { head: 'preview', byteLength: 1000, digest: 'original', truncated: true }
    }
  })
  db.prepare('DELETE FROM journal_epoch_pins').run()
  db.prepare('UPDATE journal_rows SET row_json=?').run(bounded)
  db.prepare('INSERT INTO journal_epoch_pins VALUES(?,?,?,?)').run('pin', 'session', 'epoch', 1)
  const result = await exportConversationContext({
    ...request(),
    sources: [{ ...selection, critical: false }]
  })
  expect(result.gaps).toEqual([
    { source: selection.source, reason: 'captured-incomplete', critical: true }
  ])
})
it('captures operation scope before awaits instead of retargeting a mutable host request', async () => {
  const input = request()
  const pending = exportConversationContext(input)
  input.contextGeneration = 2
  input.conversationId = 'other'
  const result = await pending
  expect(result.artifact.ownerId).toMatch(/^conversation-export:chat:1:/)
  expect(
    db
      .prepare(
        "SELECT COUNT(*) n FROM journal_epoch_pins WHERE owner_id LIKE 'conversation-export-read:%'"
      )
      .get()?.n
  ).toBe(0)
})
it('round-trips an over-8MiB Unicode tool result through the proof reader with its final suffix and pairing metadata', async () => {
  const payload = `${'甲🙂'.repeat(1200000)}\nFINAL: сохранять результат 🙂`
  const canonical = JSON.stringify({
    ...JSON.parse(raw),
    body: {
      kind: 'tool-call',
      name: 'shell',
      callId: 'call-large',
      state: 'done',
      output: {
        head: payload,
        byteLength: Buffer.byteLength(payload),
        digest: createHash('sha256').update(payload).digest('hex'),
        truncated: false
      }
    }
  })
  expect(Buffer.byteLength(canonical)).toBeGreaterThan(8 * 1024 * 1024)
  db.prepare('DELETE FROM journal_epoch_pins').run()
  db.prepare('UPDATE journal_rows SET row_json=?').run(canonical)
  db.prepare('INSERT INTO journal_epoch_pins VALUES(?,?,?,?)').run('pin', 'session', 'epoch', 1)
  const exported = await exportConversationContext(request())
  const chunks: Buffer[] = []
  for await (const row of streamConversationExportRows({ ...request(), ...exported })) {
    for await (const chunk of row.chunks) {
      chunks.push(Buffer.from(chunk))
    }
  }
  const bytes = Buffer.concat(chunks)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    createHash('sha256').update(canonical).digest('hex')
  )
  const parsed = JSON.parse(bytes.toString('utf8'))
  expect(parsed.body).toMatchObject({ name: 'shell', callId: 'call-large', state: 'done' })
  expect(parsed.body.output.head).toBe(payload)
  expect(exported.rows[0].substitutedValidationPaths).toEqual(['body/output/head'])
  expect(exported.gaps).toEqual([])
})
