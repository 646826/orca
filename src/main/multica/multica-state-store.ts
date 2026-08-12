import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { writeSecureFile } from '../../shared/secure-file'
import {
  MULTICA_STATE_FILE_MAX_BYTES,
  normalizeMulticaState,
  parseMulticaStateFile,
  upsertMulticaProfile,
  upsertMulticaRepoBinding,
  upsertMulticaSkillReceipt,
  upsertMulticaWorkspaceBinding
} from '../../shared/multica/multica-state'
import type {
  MulticaConnectionProfile,
  MulticaRepoBinding,
  MulticaSkillReceipt,
  MulticaState,
  MulticaWorkspaceBinding
} from '../../shared/multica/multica-types'

const MAX_STATE_BYTES = MULTICA_STATE_FILE_MAX_BYTES

export function resolveMulticaDataDirectory(homeDirectory = homedir()): string {
  const explicit = process.env.ORCA_MULTICA_DATA_DIR?.trim()
  if (explicit) {
    return explicit
  }
  const orcaData = process.env.ORCA_DATA_DIR?.trim()
  if (orcaData) {
    return join(orcaData, 'multica')
  }
  return join(homeDirectory, '.orca', 'multica')
}

export class MulticaStateStore {
  readonly #filePath: string
  #writeChain: Promise<void> = Promise.resolve()

  constructor(dataDirectory = resolveMulticaDataDirectory()) {
    this.#filePath = join(dataDirectory, 'state.json')
  }

  read(): MulticaState {
    if (!existsSync(this.#filePath)) {
      return normalizeMulticaState(null)
    }
    return parseMulticaStateFile(readFileSync(this.#filePath, 'utf8'), MAX_STATE_BYTES)
  }

  async write(state: MulticaState): Promise<void> {
    await this.#enqueue(() => this.#persist(state))
  }

  async putProfile(profile: MulticaConnectionProfile): Promise<MulticaState> {
    return this.#mutate((state) => upsertMulticaProfile(state, profile))
  }

  async bindRepo(binding: MulticaRepoBinding): Promise<MulticaState> {
    return this.#mutate((state) => upsertMulticaRepoBinding(state, binding))
  }

  async bindWorkspace(binding: MulticaWorkspaceBinding): Promise<MulticaState> {
    return this.#mutate((state) => upsertMulticaWorkspaceBinding(state, binding))
  }

  async putSkillReceipt(receipt: MulticaSkillReceipt): Promise<MulticaState> {
    return this.#mutate((state) => upsertMulticaSkillReceipt(state, receipt))
  }

  #persist(state: MulticaState): void {
    const normalized = normalizeMulticaState(state)
    const serialized = JSON.stringify(normalized, null, 2)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES) {
      throw new Error(`Multica state exceeds ${MAX_STATE_BYTES} bytes`)
    }
    mkdirSync(dirname(this.#filePath), { recursive: true })
    writeSecureFile(this.#filePath, serialized)
  }

  #mutate(mutator: (state: MulticaState) => MulticaState): Promise<MulticaState> {
    return this.#enqueue(() => {
      const next = mutator(this.read())
      this.#persist(next)
      return next
    })
  }

  #enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const queued = this.#writeChain.then(operation)
    this.#writeChain = queued.then(
      () => undefined,
      () => undefined
    )
    return queued
  }
}
