import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { writeSecureFile } from '../../shared/secure-file'
import {
  LIFIC_STATE_FILE_MAX_BYTES,
  normalizeLificState,
  parseLificStateFile,
  removeHarnessBinding,
  upsertHarnessBinding,
  upsertProfile,
  upsertRepoBinding,
  upsertWorkspaceBinding
} from '../../shared/lific/lific-state'
import type {
  LificConnectionProfile,
  LificHarnessBinding,
  LificRepoBinding,
  LificState,
  LificWorkspaceBinding
} from '../../shared/lific/lific-types'

const MAX_STATE_BYTES = LIFIC_STATE_FILE_MAX_BYTES

export function resolveLificDataDirectory(): string {
  const explicit = process.env.ORCA_LIFIC_DATA_DIR?.trim()
  if (explicit) {
    return explicit
  }
  const orcaData = process.env.ORCA_DATA_DIR?.trim()
  if (orcaData) {
    return join(orcaData, 'lific')
  }
  return join(homedir(), '.orca', 'lific')
}

export class LificStateStore {
  readonly #filePath: string
  #writeChain: Promise<void> = Promise.resolve()

  constructor(dataDirectory = resolveLificDataDirectory()) {
    this.#filePath = join(dataDirectory, 'state.json')
  }

  read(): LificState {
    if (!existsSync(this.#filePath)) {
      return normalizeLificState(null)
    }
    return parseLificStateFile(readFileSync(this.#filePath, 'utf8'), MAX_STATE_BYTES)
  }

  async write(state: LificState): Promise<void> {
    const normalized = normalizeLificState(state)
    const serialized = JSON.stringify(normalized, null, 2)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES) {
      throw new Error(`Lific state exceeds ${MAX_STATE_BYTES} bytes`)
    }
    this.#writeChain = this.#writeChain.then(async () => {
      mkdirSync(dirname(this.#filePath), { recursive: true })
      writeSecureFile(this.#filePath, serialized)
    })
    await this.#writeChain
  }

  async putProfile(profile: LificConnectionProfile): Promise<LificState> {
    const next = upsertProfile(this.read(), profile)
    await this.write(next)
    return next
  }

  async bindRepo(binding: LificRepoBinding): Promise<LificState> {
    const next = upsertRepoBinding(this.read(), binding)
    await this.write(next)
    return next
  }

  async bindWorkspace(binding: LificWorkspaceBinding): Promise<LificState> {
    const next = upsertWorkspaceBinding(this.read(), binding)
    await this.write(next)
    return next
  }

  async putHarness(binding: LificHarnessBinding): Promise<LificState> {
    const next = upsertHarnessBinding(this.read(), binding)
    await this.write(next)
    return next
  }

  async removeHarness(connectionProfileId: string, agentProfileId: string): Promise<LificState> {
    const next = removeHarnessBinding(this.read(), connectionProfileId, agentProfileId)
    await this.write(next)
    return next
  }
}