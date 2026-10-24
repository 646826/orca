import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import { verifyConversationAttachment } from '../agent-session-attachments/conversation-attachment-claims'
import { openConversationEvidenceChunks } from './conversation-evidence-chunks'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture(bytes: Buffer) {
  const root = await mkdtemp(join(tmpdir(), 'orca-evidence-pages-'))
  roots.push(root)
  const store = new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(root), {
    hasSession: () => true
  })
  const path = await store.storeFile('evidence.txt', bytes)
  const version = await verifyConversationAttachment({ stateDirectory: root, path })
  return { stateDirectory: root, path, version }
}
it('verifies immutable bytes once and serves bounded cross-chunk ranges', async () => {
  const bytes = Buffer.from(`${'甲🙂'.repeat(24000)}critical final constraint🙂`)
  const input = await fixture(bytes)
  const lease = await openConversationEvidenceChunks({
    ...input,
    assertAuthorized: () => {},
    signal: new AbortController().signal
  })
  try {
    const parts: Buffer[] = []
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      parts.push(await lease.read(offset, Math.min(32768, bytes.length - offset)))
    }
    expect(Buffer.concat(parts)).toEqual(bytes)
    await expect(lease.read(0, 65537)).rejects.toMatchObject({ code: 'resource-limit' })
    await expect(lease.read(-1, 1)).rejects.toMatchObject({ code: 'scope' })
  } finally {
    await lease.close()
  }
  await expect(lease.read(0, 1)).rejects.toMatchObject({ code: 'scope' })
})
it('detects post-verification same-length mutation before releasing any page', async () => {
  const input = await fixture(Buffer.from('x'.repeat(131072)))
  const lease = await openConversationEvidenceChunks({
    ...input,
    assertAuthorized: () => {},
    signal: new AbortController().signal
  })
  try {
    await writeFile(input.path, Buffer.from('y'.repeat(131072)))
    await expect(lease.read(0, 10)).rejects.toMatchObject({ code: 'corrupt-source' })
  } finally {
    await lease.close()
  }
})
it('checks revocation after asynchronous reads and aborts an established lease', async () => {
  const input = await fixture(Buffer.from('known'))
  let revoked = false
  const signal = new AbortController()
  const lease = await openConversationEvidenceChunks({
    ...input,
    assertAuthorized: () => {
      if (revoked) {
        throw new Error('revoked')
      }
    },
    signal: signal.signal
  })
  try {
    const reading = lease.read(0, 5)
    revoked = true
    await expect(reading).rejects.toThrow('revoked')
    revoked = false
    signal.abort(new Error('cancelled'))
    await expect(lease.read(0, 5)).rejects.toThrow('cancelled')
  } finally {
    await lease.close()
  }
})
it('rejects untrusted digests before establishing a lease', async () => {
  const input = await fixture(Buffer.from('known'))
  await expect(
    openConversationEvidenceChunks({
      ...input,
      version: { ...input.version, sha256: '0'.repeat(64) },
      assertAuthorized: () => {},
      signal: new AbortController().signal
    })
  ).rejects.toThrow()
})
it('rejects overlapping reads without starting an unbounded page queue', async () => {
  const input = await fixture(Buffer.alloc(131072, 42))
  const lease = await openConversationEvidenceChunks({
    ...input,
    assertAuthorized: () => {},
    signal: new AbortController().signal
  })
  try {
    const pending = lease.read(0, 65536)
    await expect(lease.read(65536, 65536)).rejects.toMatchObject({ code: 'resource-limit' })
    expect(await pending).toEqual(Buffer.alloc(65536, 42))
  } finally {
    await lease.close()
  }
})
it('refuses an oversized digest index before touching source bytes', async () => {
  const input = await fixture(Buffer.from('small'))
  await expect(
    openConversationEvidenceChunks({
      ...input,
      version: { ...input.version, byteLength: 8 * 1024 ** 3 + 1 },
      assertAuthorized: () => {},
      signal: new AbortController().signal
    })
  ).rejects.toMatchObject({ code: 'resource-limit' })
})
it('honors revoked authority during initial verification without exposing a lease', async () => {
  const input = await fixture(Buffer.alloc(131072, 42))
  let calls = 0
  await expect(
    openConversationEvidenceChunks({
      ...input,
      assertAuthorized: () => {
        if (++calls > 1) {
          throw new Error('revoked')
        }
      },
      signal: new AbortController().signal
    })
  ).rejects.toThrow('revoked')
})
it('invalidates an outstanding read immediately when the lease closes', async () => {
  const input = await fixture(Buffer.alloc(131072, 42))
  const lease = await openConversationEvidenceChunks({
    ...input,
    assertAuthorized: () => {},
    signal: new AbortController().signal
  })
  const pending = lease.read(0, 65536)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'scope' })
  const closing = lease.close()
  await Promise.all([rejected, closing])
  await lease.close()
  await expect(lease.read(0, 1)).rejects.toMatchObject({ code: 'scope' })
})
