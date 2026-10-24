import { once } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSync } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { stagePackagedProcessHost } from '../../../../config/scripts/packaged-process-host-fixture.mjs'
import {
  acquireProfileStateMaintenance,
  acquireProfileStateRuntimeAdmission
} from './profile-state-access'
import { profileStateAccessPaths } from './profile-state-access-owner'
import { openStructuredAgentSessionJournalDatabase } from '../../runtime/structured-agent-session-journal-open'
import { recordingStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { JOURNAL_DB_SCHEMA_VERSION } from '../../native-chat/agent-session-journal/journal-database-schema'

const fixture = mkdtempSync(join(tmpdir(), 'orca-state-access-process-'))
const bundle = join(fixture, 'access.cjs')
const oldRuntimeBundle = join(fixture, 'runtime-v4.cjs')
const children = new Set<ReturnType<typeof spawnProcess>>()

beforeAll(async () => {
  buildSync({
    entryPoints: [resolve(__dirname, 'profile-state-access.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external'
  })
  buildSync({
    entryPoints: [resolve(__dirname, 'profile-state-runtime-v4.fixture.ts')],
    outfile: oldRuntimeBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['@orca/process-host']
  })
  await stagePackagedProcessHost(fixture)
})

afterEach(async () => {
  await Promise.all([...children].map(stopChild))
})

afterAll(() => rmSync(fixture, { recursive: true, force: true }))

async function stopChild(child: ReturnType<typeof spawnProcess>): Promise<void> {
  children.delete(child)
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  const closed = once(child, 'close')
  child.kill('SIGKILL')
  await closed
}

const CHILD_SOURCE = `
const fs = require('node:fs')
const [root, bundle, mode] = process.argv.slice(1)
const rename = fs.renameSync
if (mode === 'candidate' || mode === 'published') {
  fs.renameSync = (from, to) => {
    if (mode === 'candidate' && String(to).endsWith('maintenance')) {
      fs.writeSync(1, 'barrier\\n')
      fs.readSync(0, Buffer.alloc(1), 0, 1)
    }
    rename(from, to)
    if (mode === 'published' && String(to).includes('participants')) {
      fs.writeSync(1, 'barrier\\n')
      fs.readSync(0, Buffer.alloc(1), 0, 1)
    }
  }
}
const access = require(bundle)
const owner = mode === 'runtime' || mode === 'published' || mode === 'journal-runtime-v4'
  ? access.acquireProfileStateRuntimeAdmission(root)
  : access.acquireProfileStateMaintenance(root)
const database = mode === 'journal-runtime-v4'
  ? access.openJournalDatabase(require('node:path').join(root, 'agent-session-journal.db'))
  : null
fs.writeSync(1, 'ready\\n')
process.stdin.resume()
`

async function startChild(root: string, mode: string): Promise<ReturnType<typeof spawnProcess>> {
  const child = spawnProcess({
    program: process.execPath,
    args: [
      '-e',
      CHILD_SOURCE,
      root,
      mode === 'journal-runtime-v4' ? oldRuntimeBundle : bundle,
      mode
    ],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', NODE_PATH: '', NODE_OPTIONS: '' }
  })
  children.add(child)
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  await new Promise<void>((resolveReady, reject) => {
    let stdout = ''
    const onData = (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.includes('ready\n') || stdout.includes('barrier\n')) {
        cleanup()
        resolveReady()
      }
    }
    const onExit = () => {
      cleanup()
      reject(new Error(`Owner child exited before its barrier: ${stderr}`))
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      child.stdout.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    child.stdout.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onError)
  })
  return child
}

describe('profile state owners across actual process death', () => {
  it('refuses journal migration while a baseline runtime holds an open schema-4 connection', async () => {
    const root = join(fixture, 'journal-runtime-v4')
    const child = await startChild(root, 'journal-runtime-v4')
    const admission = acquireProfileStateRuntimeAdmission(root)
    const databasePath = join(root, 'agent-session-journal.db')
    const before = readFileSync(databasePath)
    const logger = recordingStructuredAgentSessionLogger().logger
    try {
      expect(() =>
        openStructuredAgentSessionJournalDatabase({ stateDirectory: root, logger })
      ).toThrow()
      expect(readFileSync(databasePath)).toEqual(before)
      await stopChild(child)
      const opened = openStructuredAgentSessionJournalDatabase({ stateDirectory: root, logger })
      try {
        expect(opened.db.pragma('user_version', { simple: true })).toBe(JOURNAL_DB_SCHEMA_VERSION)
      } finally {
        opened.close()
      }
    } finally {
      admission.release()
    }
  })
  it('excludes recovery while a runtime lives and reclaims its registration after SIGKILL', async () => {
    const root = join(fixture, 'runtime')
    const child = await startChild(root, 'runtime')
    expect(() => acquireProfileStateMaintenance(root)).toThrow('in use')
    await stopChild(child)
    const maintenance = acquireProfileStateMaintenance(root)
    expect(readdirSync(profileStateAccessPaths(root).participants)).toEqual([])
    maintenance.release()
  })

  it('never steals a live maintenance owner with arbitrarily old timestamps', async () => {
    const root = join(fixture, 'maintenance')
    const child = await startChild(root, 'maintenance')
    const gate = profileStateAccessPaths(root).maintenance
    for (const file of readdirSync(gate)) {
      utimesSync(join(gate, file), 0, 0)
    }
    utimesSync(gate, 0, 0)
    expect(() => acquireProfileStateRuntimeAdmission(root)).toThrow('in use')
    expect(() => acquireProfileStateMaintenance(root)).toThrow('in use')
    await stopChild(child)
    acquireProfileStateRuntimeAdmission(root).release()
  })

  it('treats a crash before complete owner publication as an inert candidate', async () => {
    const root = join(fixture, 'candidate')
    const child = await startChild(root, 'candidate')
    acquireProfileStateRuntimeAdmission(root).release()
    await stopChild(child)
    acquireProfileStateMaintenance(root).release()
  })

  it('excludes recovery after participant publication even before runtime admission finishes', async () => {
    const root = join(fixture, 'published')
    const child = await startChild(root, 'published')
    expect(() => acquireProfileStateMaintenance(root)).toThrow('in use')
    await stopChild(child)
    acquireProfileStateMaintenance(root).release()
  })
})
