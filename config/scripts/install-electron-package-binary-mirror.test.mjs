import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceScriptPath = fileURLToPath(
  new URL('./install-electron-package-binary.mjs', import.meta.url)
)

const fallbackMirror = 'https://mirror.example.test/electron/'

describe('Electron package mirror fallback', () => {
  it('falls back after the official source fails without dropping bundled checksums', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeMirrorAwareElectronGet(projectDir)
      writeFakeExtractor(projectDir)

      const result = spawnSync(
        process.execPath,
        ['config/scripts/install-electron-package-binary.mjs'],
        {
          cwd: projectDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            npm_config_platform: 'linux',
            npm_config_arch: 'x64',
            ORCA_ELECTRON_PACKAGE_EXTRACTOR: join(projectDir, 'fake-extractor.cjs'),
            ORCA_ELECTRON_PACKAGE_FALLBACK_MIRROR: fallbackMirror,
            ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS: '0'
          }
        }
      )

      expect(result.status, result.stderr).toBe(0)
      expect(readAttempts(projectDir)).toEqual([
        {
          mirror: null,
          customDir: null,
          hasBundledChecksums: true
        },
        {
          mirror: fallbackMirror,
          customDir: '{{ version }}',
          hasBundledChecksums: true
        }
      ])
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
})

function readAttempts(projectDir) {
  return readFileSync(join(projectDir, 'electron-get.log'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

function mkTempProject() {
  const projectDir = mkdtempSync(join(tmpdir(), 'orca-electron-mirror-'))
  mkdirSync(join(projectDir, 'config', 'scripts'), { recursive: true })
  copyFileSync(
    sourceScriptPath,
    join(projectDir, 'config', 'scripts', 'install-electron-package-binary.mjs')
  )
  return projectDir
}

function writeFakeElectronPackage(projectDir) {
  const electronDir = join(projectDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(
    join(electronDir, 'package.json'),
    JSON.stringify({ name: 'electron', version: '43.1.0' })
  )
  writeFileSync(
    join(electronDir, 'checksums.json'),
    JSON.stringify({ 'electron-v43.1.0-linux-x64.zip': 'trusted-sha256' })
  )
}

function writeMirrorAwareElectronGet(projectDir) {
  const getDir = join(projectDir, 'node_modules', 'electron', 'node_modules', '@electron', 'get')
  mkdirSync(getDir, { recursive: true })
  writeFileSync(
    join(getDir, 'index.js'),
    `
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

exports.downloadArtifact = async function downloadArtifact(details) {
  const mirrorOptions = details.mirrorOptions || null
  appendFileSync('electron-get.log', JSON.stringify({
    mirror: mirrorOptions ? mirrorOptions.mirror : null,
    customDir: mirrorOptions ? mirrorOptions.customDir : null,
    hasBundledChecksums: Boolean(details.checksums)
  }) + '\\n')

  if (!mirrorOptions || mirrorOptions.mirror !== ${JSON.stringify(fallbackMirror)}) {
    const cause = Object.assign(new Error('official source closed the socket'), {
      code: 'UND_ERR_SOCKET'
    })
    throw Object.assign(new TypeError('fetch failed'), { cause })
  }

  mkdirSync(details.cacheRoot, { recursive: true })
  const artifactPath = join(details.cacheRoot, 'electron.zip')
  writeFileSync(artifactPath, 'fake zip')
  return artifactPath
}
`
  )
}

function writeFakeExtractor(projectDir) {
  writeFileSync(
    join(projectDir, 'fake-extractor.cjs'),
    `
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const extractDir = process.argv[3]
mkdirSync(extractDir, { recursive: true })
writeFileSync(join(extractDir, 'electron'), '')
writeFileSync(join(extractDir, 'version'), 'v43.1.0')
`
  )
}
