import type {
  LificActivity,
  LificBot,
  LificComment,
  LificIssue,
  LificPage,
  LificPlan,
  LificPlanStep,
  LificProject,
  LificSearchResult
} from '../../shared/lific/lific-types'

export type JsonObject = Record<string, unknown>

export function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Lific response: ${label} must be an object`)
  }
  return value as JsonObject
}

export function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid Lific response: ${label} must be an array`)
  }
  return value
}

export function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid Lific response: ${label} must be a non-empty string`)
  }
  return value
}

export function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid Lific response: ${label} must be a number`)
  }
  return value
}

export function mapProject(value: unknown): LificProject {
  const raw = object(value, 'project')
  const description = typeof raw.description === 'string' ? raw.description : undefined
  return {
    id: number(raw.id, 'project.id'),
    identifier: string(raw.identifier, 'project.identifier'),
    name: string(raw.name, 'project.name'),
    ...(description ? { description } : {})
  }
}

export function mapIssue(value: unknown): LificIssue {
  const raw = object(value, 'issue')
  const status = typeof raw.status === 'string' ? raw.status : undefined
  const description =
    typeof raw.description === 'string' || raw.description === null ? raw.description : undefined
  const priority =
    typeof raw.priority === 'string' || typeof raw.priority === 'number' || raw.priority === null
      ? raw.priority
      : undefined
  const projectId = typeof raw.project_id === 'number' ? raw.project_id : undefined
  const url = typeof raw.url === 'string' ? raw.url : undefined
  return {
    id: number(raw.id, 'issue.id'),
    identifier: string(raw.identifier, 'issue.identifier'),
    title: string(raw.title, 'issue.title'),
    ...(status ? { status } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(url ? { url } : {}),
    raw
  }
}

export function mapComment(value: unknown): LificComment {
  const raw = object(value, 'comment')
  const createdAt = typeof raw.created_at === 'string' ? raw.created_at : undefined
  return {
    id: number(raw.id, 'comment.id'),
    content: string(raw.content ?? raw.body, 'comment.content'),
    ...(createdAt ? { createdAt } : {}),
    raw
  }
}

export function mapPlanStep(value: unknown): LificPlanStep {
  const raw = object(value, 'plan step')
  const children = Array.isArray(raw.children) ? raw.children.map(mapPlanStep) : []
  const description = typeof raw.description === 'string' ? raw.description : undefined
  const issueId =
    typeof raw.issue_id === 'number' || raw.issue_id === null ? raw.issue_id : undefined
  const parentStepId =
    typeof raw.parent_step_id === 'number' || raw.parent_step_id === null
      ? raw.parent_step_id
      : undefined
  return {
    id: number(raw.id, 'plan step.id'),
    title: string(raw.title, 'plan step.title'),
    done: raw.done === true,
    ...(description ? { description } : {}),
    ...(issueId !== undefined ? { issueId } : {}),
    ...(parentStepId !== undefined ? { parentStepId } : {}),
    children,
    raw
  }
}

export function mapPlan(value: unknown): LificPlan {
  const raw = object(value, 'plan')
  const description =
    typeof raw.description === 'string' || raw.description === null ? raw.description : undefined
  return {
    id: number(raw.id, 'plan.id'),
    identifier: string(raw.identifier, 'plan.identifier'),
    projectId: number(raw.project_id, 'plan.project_id'),
    title: string(raw.title, 'plan.title'),
    status: typeof raw.status === 'string' ? raw.status : 'active',
    ...(description !== undefined ? { description } : {}),
    steps: Array.isArray(raw.steps) ? raw.steps.map(mapPlanStep) : [],
    raw
  }
}

export function mapActivity(value: unknown): LificActivity {
  const raw = object(value, 'activity')
  const actorUsername =
    typeof raw.actor_username === 'string' || raw.actor_username === null
      ? raw.actor_username
      : undefined
  return {
    id: number(raw.id, 'activity.id'),
    timestamp: string(raw.ts, 'activity.ts'),
    action: string(raw.action, 'activity.action'),
    entityType: string(raw.entity_type, 'activity.entity_type'),
    entityId: number(raw.entity_id, 'activity.entity_id'),
    actorIsBot: raw.actor_is_bot === true,
    transport: string(raw.transport, 'activity.transport'),
    ...(actorUsername !== undefined ? { actorUsername } : {}),
    raw
  }
}

export function mapPage(value: unknown): LificPage {
  const raw = object(value, 'page')
  const content = typeof raw.content === 'string' ? raw.content : undefined
  const projectId = typeof raw.project_id === 'number' ? raw.project_id : undefined
  return {
    id: number(raw.id, 'page.id'),
    identifier: string(raw.identifier, 'page.identifier'),
    title: string(raw.title, 'page.title'),
    ...(content ? { content } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    raw
  }
}

export function mapSearchResult(value: unknown): LificSearchResult {
  const raw = object(value, 'search result')
  const identifier =
    typeof raw.identifier === 'string' || raw.identifier === null ? raw.identifier : undefined
  const projectId =
    typeof raw.project_id === 'number' || raw.project_id === null ? raw.project_id : undefined
  return {
    resultType: string(raw.result_type, 'search result.result_type'),
    id: number(raw.id, 'search result.id'),
    title: string(raw.title, 'search result.title'),
    snippet: typeof raw.snippet === 'string' ? raw.snippet : '',
    ...(identifier !== undefined ? { identifier } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    raw
  }
}

export function mapBot(value: unknown): LificBot {
  const raw = object(value, 'bot')
  return {
    id: number(raw.id, 'bot.id'),
    username: string(raw.username, 'bot.username'),
    displayName: string(raw.display_name, 'bot.display_name')
  }
}
