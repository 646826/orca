import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ConversationScratchClient } from './conversation-scratch-client'

const roots: string[] = []
const clients: ConversationScratchClient[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture(body: string) {
  const root = mkdtempSync(join(tmpdir(), 'orca-scratch-client-'))
  roots.push(root)
  const workerPath = join(root, 'worker.cjs')
  writeFileSync(
    workerPath,
    `const { parentPort, workerData } = require('node:worker_threads'); ${body}`
  )
  const client = new ConversationScratchClient(root, { workerPath })
  clients.push(client)
  return { client, root }
}
it('does not release scratch ownership until the worker exits and private cleanup completes', async () => {
  const { client, root } = fixture(`
    require('node:fs').mkdirSync(workerData.directory);
    parentPort.postMessage({ id: 0, ok: true, value: null });
    parentPort.on('message', request => {
      parentPort.postMessage({ id: request.id, ok: true, value: null });
      if (request.command === 'close') parentPort.close();
    });
  `)
  await client.ready
  expect(readdirSync(root).some((name) => name.startsWith('conversation-scratch-'))).toBe(true)
  await client.close()
  expect(readdirSync(root)).toEqual(['worker.cjs'])
  await expect(client.openHistory()).rejects.toThrow()
})
it('rejects stale acknowledgements and establishes exit before removing private scratch', async () => {
  const { client, root } = fixture(`
    require('node:fs').mkdirSync(workerData.directory);
    parentPort.postMessage({ id: 0, ok: true, value: null });
    parentPort.on('message', request => {
      parentPort.postMessage({ id: request.id + 1, ok: true, value: null });
    });
  `)
  await client.ready
  await expect(client.openHistory()).rejects.toThrow('Invalid conversation scratch response')
  await client.close()
  expect(readdirSync(root)).toEqual(['worker.cjs'])
})
it('refuses concurrent command admission without queuing another payload', async () => {
  const { client } = fixture(`
    parentPort.postMessage({ id: 0, ok: true, value: null });
    parentPort.on('message', request => {
      if (request.command === 'close') {
        parentPort.postMessage({ id: request.id, ok: true, value: null });
        parentPort.close();
      } else setImmediate(() => parentPort.postMessage({ id: request.id, ok: true, value: null }));
    });
  `)
  await client.ready
  const first = client.openHistory()
  await expect(client.openHistory()).rejects.toThrow('already in flight')
  await first
})
it('bounds jobs during initialization and reuses admission only after completed cleanup', async () => {
  const body = `
    parentPort.postMessage({ id: 0, ok: true, value: null });
    parentPort.on('message', request => {
      parentPort.postMessage({ id: request.id, ok: true, value: null });
      if (request.command === 'close') parentPort.close();
    });
  `
  const admitted = Array.from({ length: 4 }, () => fixture(body).client)
  expect(() => fixture(body)).toThrow('replay page byte budget')
  await Promise.all(admitted.map((client) => client.ready))
  await admitted[0]!.close()
  const replacement = fixture(body).client
  await replacement.ready
})
it('refuses commands before readiness instead of retaining queued payloads', async () => {
  const { client } = fixture(`
    parentPort.postMessage({ id: 0, ok: true, value: null });
    parentPort.on('message', request => {
      parentPort.postMessage({ id: request.id, ok: true, value: null });
      if (request.command === 'close') parentPort.close();
    });
  `)
  await expect(client.openHistory()).rejects.toThrow('already in flight')
  await client.ready
})
it('cleans an exited worker after an unacknowledged command without treating that command as successful', async () => {
  const { client, root } = fixture(`
    require('node:fs').mkdirSync(workerData.directory);
    parentPort.postMessage({ id: 0, ok: true, value: null });
    parentPort.on('message', () => process.exit(73));
  `)
  await client.ready
  await expect(client.openHistory()).rejects.toThrow('exited (73)')
  await client.close()
  expect(readdirSync(root)).toEqual(['worker.cjs'])
})
