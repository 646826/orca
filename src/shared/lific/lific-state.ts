import type {
  LificConnectionProfile,
  LificHarnessBinding,
  LificRepoBinding,
  LificState,
  LificWorkspaceBinding
} from './lific-types'

export const LIFIC_STATE_FILE_MAX_BYTES = 2 * 1024 * 1024

const EMPTY_STATE: LificState = {
  schemaVersion: 1,
  profiles: [],
  repoBindings: [],
  harnessBindings: [],
  workspaceBindings: []
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
      )
    : []
}

export function parseLificStateFile(
  text: string,
  maxBytes = LIFIC_STATE_FILE_MAX_BYTES
): LificState {
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new Error(`Lific state exceeds ${maxBytes} bytes`)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('Lific state contains invalid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Lific state document')
  }
  const schemaVersion = (value as Record<string, unknown>).schemaVersion
  if (schemaVersion !== 1) {
    throw new Error(`Unsupported Lific state schema version '${String(schemaVersion)}'`)
  }
  return normalizeLificState(value)
}

export function normalizeLificState(value: unknown): LificState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return structuredClone(EMPTY_STATE)
  }
  const raw = value as Record<string, unknown>
  return {
    schemaVersion: 1,
    profiles: records(raw.profiles) as LificConnectionProfile[],
    repoBindings: records(raw.repoBindings) as LificRepoBinding[],
    harnessBindings: records(raw.harnessBindings) as LificHarnessBinding[],
    workspaceBindings: records(raw.workspaceBindings) as LificWorkspaceBinding[]
  }
}

export function upsertProfile(state: LificState, profile: LificConnectionProfile): LificState {
  return {
    ...state,
    profiles: [...state.profiles.filter((entry) => entry.id !== profile.id), profile]
  }
}

export function upsertRepoBinding(state: LificState, binding: LificRepoBinding): LificState {
  return {
    ...state,
    repoBindings: [
      ...state.repoBindings.filter((entry) => entry.repoId !== binding.repoId),
      binding
    ]
  }
}

export function upsertHarnessBinding(state: LificState, binding: LificHarnessBinding): LificState {
  return {
    ...state,
    harnessBindings: [
      ...state.harnessBindings.filter(
        (entry) =>
          !(
            entry.connectionProfileId === binding.connectionProfileId &&
            entry.agentProfileId === binding.agentProfileId
          )
      ),
      binding
    ]
  }
}

export function upsertWorkspaceBinding(
  state: LificState,
  binding: LificWorkspaceBinding
): LificState {
  return {
    ...state,
    workspaceBindings: [
      ...state.workspaceBindings.filter((entry) => entry.workspaceId !== binding.workspaceId),
      binding
    ]
  }
}

export function removeHarnessBinding(
  state: LificState,
  connectionProfileId: string,
  agentProfileId: string
): LificState {
  return {
    ...state,
    harnessBindings: state.harnessBindings.filter(
      (entry) =>
        !(
          entry.connectionProfileId === connectionProfileId &&
          entry.agentProfileId === agentProfileId
        )
    )
  }
}
