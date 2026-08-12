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
import {
  DEFAULT_ELECTRON_DOWNLOAD_RETRY_DELAYS_MS,
  parseElectronDownloadRetryDelays
} from './install-electron-package-binary.mjs'

const sourceScriptPath = fileURLToPath(
  new URL('./install-electron-package-binary.mjs', import.meta.url)
)

describe('Electron package download resilience', () => {
  it('uses a bounded retry window long enough to survive transient runner outages', () => {
    expect(DEFAULT_ELECTRON_DOWNLOAD_RETRY_DELAYS_MS).toEqual([
      1_000,
      3_000,
      7_000,
      15_000,
      30_000
    ])
    expect(DEFAULT_ELECTRON_DOWNLOAD_RETRY_DELAYS_MS).toHaveLength(5)
  })

  it('parses deterministic test overrides and rejects unsafe values', () => {
    expect(parseElectronDownloadRetryDelays('0,5,10')).toEqual([0, 5, 10])
    expect(() => parseElectronDownloadRetryDelays('')).toThrow(
      'ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS must not be empty'
    )
    expect(() => parseElectronDownloadRetryDelays('0,-1')).toThrow(
      'ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS must contain non-negative integers'
    )
    expect(() => parseElectronDownloadRetryDelays('1'.repeat(30_000))).toThrow(
      'ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS is too long'
    )
  })

  it('uses fresh temp and cache directories for every download attempt', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, { downloadFailures: 2 })
      writeFakeExtractor(projectDir)

      const result = runInstallScript(projectDir, {
        ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS: '0,0'
      })

      expect(result.status, result.stderr).toBe(0)
      const attempts = readAttempts(projectDir)
      expect(attempts).toHaveLength(3)
      expect(new Set(attempts.map((attempt) => attempt.cacheRoot)).size).toBe(3)
      expect(new Set(attempts.map((attempt) => attempt.tempDirectory)).size).toBe(3)
      for (const attempt of attempts) {
        expect(attempt.cacheRoot).toContain(attempt.tempDirectory)
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('retries server errors exposed through a standard Fetch Response status', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      // @electron/get attaches the native Fetch Response object rather than a statusCode field.
      writeFakeElectronGet(projectDir, { downloadFailures: 1, responseStatus: 503 })
      writeFakeExtractor(projectDir)

      const result = runInstallScript(projectDir, {
        ORCA_ELECTRON_PACKAGE_RETRY_DELAYS_MS: '0'
      })

      expect(result.status, result.stderr).toBe(0)
      expect(readAttempts(projectDir)).toHaveLength(2)
      expect(result.stderr).toContain('Transient Electron download failure (HTTP 503)')
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
  const projectDir = mkdtempSync(join(tmpdir(), 'orca-electron-resilience-'))
  mkdirSync(join(projectDir, 'config', 'scripts'), { recursive: true })
  copyFileSync(
    sourceScriptPath,
    join(projectDir, 'config', 'scripts', 'install-electron-package-binary.mjs')
  )
  return projectDir
}

function runInstallScript(projectDir, extraEnv = {}) {
  return spawnSync(process.execPath, ['config/scripts/install-electron-package-binary.mjs'], {
    cwd: projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_platform: 'linux',
      npm_config_arch: 'x64',
      ORCA_ELECTRON_PACKAGE_EXTRACTOR: join(projectDir, 'fake-extractor.cjs'),
      ...extraEnv
    }
  })
}

function writeFakeElectronPackage(projectDir) {
  const electronDir = join(projectDir, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(
    join(electronDir, 'package.json'),
    JSON.stringify({ name: 'electron', version: '41.5.0' })
  )
  writeFileSync(join(electronDir, 'checksums.json'), '{}')
}

function writeFakeElectronGet(
  projectDir,
  { downloadFailures, responseStatus = null }
) {
  const getDir = join(projectDir, 'node_modules', 'electron', 'node_modules', '@electron', 'get')
  mkdirSync(getDir, { recursive: true })
  writeFileSync(
    join(getDir, 'index.js'),
    `
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
let attempt = 0
exports.downloadArtifact = async function downloadArtifact(details) {
  attempt += 1
  appendFileSync('electron-get.log', JSON.stringify({
    cacheRoot: details.cacheRoot,
    tempDirectory: details.tempDirectory
  }) + '\\n')
  if (attempt <= ${JSON.stringify(downloadFailures)}) {
    if (${JSON.stringify(responseStatus)} !== null) {
      throw Object.assign(new Error('download failed'), {
        response: { status: ${JSON.stringify(responseStatus)} }
      })
    }
    const cause = Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' })
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
writeFileSync(join(extractDir, 'version'), 'v41.5.0')
`
  )
}
