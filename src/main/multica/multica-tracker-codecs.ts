const MAX_LIST_ITEMS = 10_000
const MAX_ID_LENGTH = 512
const MAX_NAME_LENGTH = 16 * 1024
const MAX_TEXT_LENGTH = 256 * 1024
const MAX_URL_LENGTH = 16 * 1024
const MAX_TIMESTAMP_LENGTH = 128
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

export type MulticaWorkspaceRepo = {
  url: string
  description?: string
}

export type MulticaWorkspaceSummary = {
  id: string
  name: string
  slug: string
}

export type MulticaWorkspace = MulticaWorkspaceSummary & {
  description: string | null
  context: string | null
  settings: Record<string, unknown>
  repos: MulticaWorkspaceRepo[]
  issuePrefix: string
  avatarUrl: string | null
  createdAt: string
  updatedAt: string
}

export type MulticaProject = {
  id: string
  workspaceId: string
  title: string
  description: string | null
  icon: string | null
  status: string
  priority: string
  leadType: string | null
  leadId: string | null
  startDate: string | null
  dueDate: string | null
  createdAt: string
  updatedAt: string
  issueCount: number
  doneCount: number
  resourceCount: number
}

export type MulticaProjectList = {
  projects: MulticaProject[]
  total: number
}

export type MulticaTrackerCodecErrorCode =
  | 'invalid-workspace'
  | 'invalid-workspace-list'
  | 'invalid-project'
  | 'invalid-project-list'

const ERROR_MESSAGES: Record<MulticaTrackerCodecErrorCode, string> = {
  'invalid-workspace': 'Multica returned an invalid workspace payload',
  'invalid-workspace-list': 'Multica returned an invalid workspace list',
  'invalid-project': 'Multica returned an invalid project payload',
  'invalid-project-list': 'Multica returned an invalid project list'
}

export class MulticaTrackerCodecError extends Error {
  constructor(readonly code: MulticaTrackerCodecErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'MulticaTrackerCodecError'
  }
}

export function parseMulticaWorkspace(value: unknown): MulticaWorkspace {
  const code = 'invalid-workspace' as const
  const object = requireRecord(value, code)
  return {
    ...parseWorkspaceSummary(object, code),
    description: requireNullableString(object.description, MAX_TEXT_LENGTH, code),
    context: requireNullableString(object.context, MAX_TEXT_LENGTH, code),
    settings: { ...requireRecord(object.settings, code) },
    repos: parseWorkspaceRepos(object.repos, code),
    issuePrefix: requireString(object.issue_prefix, MAX_ID_LENGTH, code),
    avatarUrl: requireNullableString(object.avatar_url, MAX_URL_LENGTH, code),
    createdAt: requireTimestamp(object.created_at, code),
    updatedAt: requireTimestamp(object.updated_at, code)
  }
}

export function parseMulticaWorkspaceList(value: unknown): MulticaWorkspaceSummary[] {
  const code = 'invalid-workspace-list' as const
  const values = requireBoundedArray(value, code)
  return values.map((entry) => parseWorkspaceSummary(requireRecord(entry, code), code))
}

export function parseMulticaProject(value: unknown): MulticaProject {
  const code = 'invalid-project' as const
  const object = requireRecord(value, code)
  const leadType = requireNullableString(object.lead_type, MAX_ID_LENGTH, code)
  const leadId = requireNullableString(object.lead_id, MAX_ID_LENGTH, code)
  if ((leadType === null) !== (leadId === null)) {
    throw new MulticaTrackerCodecError(code)
  }

  return {
    id: requireString(object.id, MAX_ID_LENGTH, code),
    workspaceId: requireString(object.workspace_id, MAX_ID_LENGTH, code),
    title: requireString(object.title, MAX_NAME_LENGTH, code),
    description: requireNullableString(object.description, MAX_TEXT_LENGTH, code),
    icon: requireNullableString(object.icon, MAX_NAME_LENGTH, code),
    status: requireString(object.status, MAX_ID_LENGTH, code),
    priority: requireString(object.priority, MAX_ID_LENGTH, code),
    leadType,
    leadId,
    startDate: requireNullableDate(object.start_date, code),
    dueDate: requireNullableDate(object.due_date, code),
    createdAt: requireTimestamp(object.created_at, code),
    updatedAt: requireTimestamp(object.updated_at, code),
    issueCount: requireCount(object.issue_count, code),
    doneCount: requireCount(object.done_count, code),
    resourceCount: requireCount(object.resource_count, code)
  }
}

export function parseMulticaProjectList(value: unknown): MulticaProjectList {
  const code = 'invalid-project-list' as const
  if (Array.isArray(value)) {
    const projects = requireBoundedArray(value, code).map(parseProjectListEntry)
    return { projects, total: projects.length }
  }

  const object = requireRecord(value, code)
  const projects = requireBoundedArray(object.projects, code).map(parseProjectListEntry)
  const total = requireCount(object.total, code)
  if (total < projects.length) {
    throw new MulticaTrackerCodecError(code)
  }
  return { projects, total }
}

function parseWorkspaceSummary(
  object: Record<string, unknown>,
  code: 'invalid-workspace' | 'invalid-workspace-list'
): MulticaWorkspaceSummary {
  return {
    id: requireString(object.id, MAX_ID_LENGTH, code),
    name: requireString(object.name, MAX_NAME_LENGTH, code),
    slug: requireString(object.slug, MAX_ID_LENGTH, code)
  }
}

function parseWorkspaceRepos(
  value: unknown,
  code: 'invalid-workspace'
): MulticaWorkspaceRepo[] {
  return requireBoundedArray(value, code).map((entry) => {
    const object = requireRecord(entry, code)
    const repo: MulticaWorkspaceRepo = {
      url: requireString(object.url, MAX_URL_LENGTH, code)
    }
    if (object.description !== undefined) {
      repo.description = requireString(object.description, MAX_TEXT_LENGTH, code)
    }
    return repo
  })
}

function parseProjectListEntry(value: unknown): MulticaProject {
  try {
    return parseMulticaProject(value)
  } catch {
    throw new MulticaTrackerCodecError('invalid-project-list')
  }
}

function requireRecord(
  value: unknown,
  code: MulticaTrackerCodecErrorCode
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MulticaTrackerCodecError(code)
  }
  return value as Record<string, unknown>
}

function requireBoundedArray(
  value: unknown,
  code: MulticaTrackerCodecErrorCode
): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new MulticaTrackerCodecError(code)
  }
  return value
}

function requireString(
  value: unknown,
  maximumLength: number,
  code: MulticaTrackerCodecErrorCode
): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maximumLength
  ) {
    throw new MulticaTrackerCodecError(code)
  }
  return value
}

function requireNullableString(
  value: unknown,
  maximumLength: number,
  code: MulticaTrackerCodecErrorCode
): string | null {
  if (value === null) {
    return null
  }
  return requireString(value, maximumLength, code)
}

function requireTimestamp(value: unknown, code: MulticaTrackerCodecErrorCode): string {
  const timestamp = requireString(value, MAX_TIMESTAMP_LENGTH, code)
  if (!timestamp.includes('T') || Number.isNaN(Date.parse(timestamp))) {
    throw new MulticaTrackerCodecError(code)
  }
  return timestamp
}

function requireNullableDate(
  value: unknown,
  code: MulticaTrackerCodecErrorCode
): string | null {
  if (value === null) {
    return null
  }
  const date = requireString(value, 10, code)
  const match = DATE_PATTERN.exec(date)
  if (!match) {
    throw new MulticaTrackerCodecError(code)
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new MulticaTrackerCodecError(code)
  }
  return date
}

function requireCount(value: unknown, code: MulticaTrackerCodecErrorCode): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new MulticaTrackerCodecError(code)
  }
  return value as number
}
