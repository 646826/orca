import { copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { MainConfigFactory } from 'electron-vite'
import { build } from 'vite'
import { runProcessSync } from '@orca/process-host'
import { electronViteConfig } from '../../electron.vite.config.ts'
import { removeTree } from '../../src/shared/windows-transient-lock-removal.ts'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
const { copyFiles, FileMatcher } = builderRequire('app-builder-lib/out/fileMatcher')
const { createPackagedRuntimeNodeModuleResources } = require('../packaged-runtime-node-modules.cjs')

it('runs the production evidence-server bundle with isolated packaged validators over HTTP', async () => {
  const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-packaged-mcp-'))
  try {
    const mainDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'main')
    await mkdir(mainDir, { recursive: true })
    // Only the fixture entry/output changes: dependency resolution and externalization
    // come from the production config. Entry-specific bootstrap guards do not apply.
    const config = await new MainConfigFactory(
      {
        ...electronViteConfig.main,
        build: {
          ...electronViteConfig.main.build,
          outDir: mainDir,
          sourcemap: false,
          rollupOptions: {
            input: resolve('src/main/acp/acp-conversation-evidence-server.ts'),
            preserveEntrySignatures: 'exports-only',
            output: { format: 'cjs', entryFileNames: 'proof.cjs', chunkFileNames: '[name].cjs' }
          }
        }
      },
      {},
      {}
    ).build()
    await build({ ...config, configFile: false })
    await copyFiles(
      createPackagedRuntimeNodeModuleResources('darwin').map(
        (entry) =>
          new FileMatcher(entry.from, join(resourcesDir, entry.to), (value) => value, entry.filter)
      )
    )
    const sdkRequire = createRequire(require.resolve('@modelcontextprotocol/sdk/server/index.js'))
    const stagedRequire = createRequire(join(mainDir, 'proof.cjs'))
    for (const name of ['ajv', 'ajv-formats']) {
      const installed = JSON.parse(
        await readFile(sdkRequire.resolve(`${name}/package.json`), 'utf8')
      )
      const staged = JSON.parse(
        await readFile(stagedRequire.resolve(`${name}/package.json`), 'utf8')
      )
      expect(staged.name).toBe(installed.name)
      expect(staged.version).toBe(installed.version)
    }
    const entry = join(mainDir, 'http-proof.cjs')
    await copyFile(new URL('./packaged-mcp-runtime.fixture.cjs', import.meta.url), entry)
    const result = runProcessSync({
      program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
      args: [entry],
      cwd: resourcesDir,
      timeoutMs: 15_000,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', ORCA_BACKGROUND_LAUNCH: '1' }
    })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('packaged-evidence-http-ok')
  } finally {
    await removeTree(resourcesDir)
  }
}, 30_000)
