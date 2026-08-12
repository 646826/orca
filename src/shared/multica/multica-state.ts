import type {
  MulticaConnectionProfile,
  MulticaRepoBinding,
  MulticaSkillReceipt,
  MulticaState,
  MulticaWorkspaceBinding
} from './multica-types'

export const MULTICA_STATE_FILE_MAX_BYTES = 2 * 1024 * 1024

const EMPTY_STATE: MulticaState = {
  schemaVersion: 1,
  profiles: [],
  repoBindings: [],
  workspaceBindings: [],
  skillReceipts: []
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
      )
    : []
}

export function parseMulticaStateFile(
  text: string,
  maxBytes = MULTICA_STATE_FILE_MAX_BYTES
): MulticaState {
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new Error(`Multica state exceeds ${maxBytes} bytes`)
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('Multica state contains invalid JSON')
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Multica state document')
  }

  const schemaVersion = (value as Record<string, unknown>).schemaVersion
  if (schemaVersion !== 1) {
    throw new Error(`Unsupported Multica state schema version '${String(schemaVersion)}'`)
  }

  return normalizeMulticaState(value)
}

export function normalizeMulticaState(value: unknown): MulticaState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return structuredClone(EMPTY_STATE)
  }

  const raw = value as Record<string, unknown>
  return {
    schemaVersion: 1,
    profiles: records(raw.profiles) as MulticaConnectionProfile[],
    repoBindings: records(raw.repoBindings) as MulticaRepoBinding[],
    workspaceBindings: records(raw.workspaceBindings) as MulticaWorkspaceBinding[],
    skillReceipts: records(raw.skillReceipts) as MulticaSkillReceipt[]
  }
}

export function upsertMulticaProfile(
  state: MulticaState,
  profile: MulticaConnectionProfile
): MulticaState {
  return {
    ...state,
    profiles: [...state.profiles.filter((entry) => entry.id !== profile.id), profile]
  }
}

export function upsertMulticaRepoBinding(
  state: MulticaState,
  binding: MulticaRepoBinding
): MulticaState {
  return {
    ...state,
    repoBindings: [
      ...state.repoBindings.filter((entry) => entry.repoId !== binding.repoId),
      binding
    ]
  }
}

export function upsertMulticaWorkspaceBinding(
  state: MulticaState,
  binding: MulticaWorkspaceBinding
): MulticaState {
  return {
    ...state,
    workspaceBindings: [
      ...state.workspaceBindings.filter((entry) => entry.workspaceId !== binding.workspaceId),
      binding
    ]
  }
}

export function upsertMulticaSkillReceipt(
  state: MulticaState,
  receipt: MulticaSkillReceipt
): MulticaState {
  return {
    ...state,
    skillReceipts: [
      ...state.skillReceipts.filter(
        (entry) =>
          !(entry.direction === receipt.direction && entry.sourceId === receipt.sourceId)
      ),
      receipt
    ]
  }
}
