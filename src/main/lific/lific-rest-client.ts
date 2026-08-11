import { findLificClient } from '../../shared/lific/lific-client-registry'
import { redactLificSecrets } from '../../shared/lific/lific-redaction'
import type {
  LificActivityFeed,
  LificBot,
  LificBotConnection,
  LificClientId,
  LificComment,
  LificIssue,
  LificPage,
  LificPlan,
  LificProject,
  LificSearchResult
} from '../../shared/lific/lific-types'
import {
  array,
  mapActivity,
  mapBot,
  mapComment,
  mapIssue,
  mapPage,
  mapPlan,
  mapProject,
  mapSearchResult,
  object,
  string,
  type JsonObject
} from './lific-rest-mappers'

export class LificRestClient {
  readonly #baseUrl: string
  readonly #credential: string
  readonly #fetch: typeof fetch

  constructor(input: { baseUrl: string; credential: string; fetchImpl?: typeof fetch }) {
    this.#baseUrl = input.baseUrl.replace(/\/+$/, '')
    this.#credential = input.credential
    this.#fetch = input.fetchImpl ?? fetch
  }

  async #request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.#credential}`,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {})
    }
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) }
    })
    const text = await response.text()
    let body: unknown = null
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
    if (!response.ok) {
      const rawMessage =
        typeof body === 'object' && body !== null && 'error' in body
          ? String((body as JsonObject).error)
          : `${response.status} ${response.statusText}`
      throw new Error(`Lific request failed: ${redactLificSecrets(rawMessage)}`)
    }
    return body
  }

  async health(): Promise<boolean> {
    try {
      await this.#request('/api/health')
      return true
    } catch {
      return false
    }
  }

  async createBot(tool: LificClientId): Promise<LificBotConnection> {
    if (!findLificClient(tool)) {
      throw new Error(`Unknown Lific client '${tool}'`)
    }
    const raw = object(
      await this.#request('/api/auth/bots', {
        method: 'POST',
        body: JSON.stringify({ tool })
      }),
      'create bot response'
    )
    const returnedTool = string(raw.tool, 'tool')
    if (returnedTool !== tool) {
      throw new Error(`Lific returned bot for '${returnedTool}', expected '${tool}'`)
    }
    return { bot: mapBot(raw.bot), key: string(raw.key, 'key'), tool }
  }

  async listBots(): Promise<LificBot[]> {
    return array(await this.#request('/api/auth/bots'), 'bots').map(mapBot)
  }

  async disconnectBot(id: number): Promise<void> {
    await this.#request(`/api/auth/bots/${encodeURIComponent(String(id))}/disconnect`, {
      method: 'POST'
    })
  }

  async listProjects(): Promise<LificProject[]> {
    return array(await this.#request('/api/projects'), 'projects').map(mapProject)
  }

  async listIssues(input: { projectId: number; limit?: number }): Promise<LificIssue[]> {
    const params = new URLSearchParams({
      project_id: String(input.projectId),
      limit: String(input.limit ?? 50)
    })
    return array(await this.#request(`/api/issues?${params}`), 'issues').map(mapIssue)
  }

  async getIssue(identifier: string): Promise<LificIssue | null> {
    try {
      return mapIssue(await this.#request(`/api/issues/resolve/${encodeURIComponent(identifier)}`))
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) {
        return null
      }
      throw error
    }
  }

  async updateIssue(issue: LificIssue, update: Record<string, unknown>): Promise<LificIssue> {
    return mapIssue(
      await this.#request(`/api/issues/${issue.id}`, {
        method: 'PUT',
        body: JSON.stringify(update)
      })
    )
  }

  async listComments(issue: LificIssue): Promise<LificComment[]> {
    return array(await this.#request(`/api/issues/${issue.id}/comments`), 'comments').map(
      mapComment
    )
  }

  async addComment(issue: LificIssue, content: string): Promise<LificComment> {
    return mapComment(
      await this.#request(`/api/issues/${issue.id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ content })
      })
    )
  }

  async listPlans(projectId: number, status?: string): Promise<LificPlan[]> {
    const params = new URLSearchParams({ project_id: String(projectId) })
    if (status) {
      params.set('status', status)
    }
    return array(await this.#request(`/api/plans?${params}`), 'plans').map(mapPlan)
  }

  async getPlan(identifier: string): Promise<LificPlan | null> {
    try {
      return mapPlan(await this.#request(`/api/plans/resolve/${encodeURIComponent(identifier)}`))
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) {
        return null
      }
      throw error
    }
  }

  async updatePlanStep(
    planId: number,
    stepId: number,
    update: Record<string, unknown>
  ): Promise<LificPlan> {
    const raw = object(
      await this.#request(
        `/api/plans/${encodeURIComponent(String(planId))}/steps/${encodeURIComponent(String(stepId))}`,
        { method: 'PUT', body: JSON.stringify(update) }
      ),
      'plan step update'
    )
    return mapPlan(raw.plan ?? raw)
  }

  async listProjectActivity(projectId: number, limit = 50): Promise<LificActivityFeed> {
    const params = new URLSearchParams({ limit: String(limit) })
    const raw = object(
      await this.#request(
        `/api/projects/${encodeURIComponent(String(projectId))}/activity?${params}`
      ),
      'activity feed'
    )
    return {
      items: array(raw.items, 'activity items').map(mapActivity),
      hasMore: raw.has_more === true
    }
  }

  async listPages(projectId: number): Promise<LificPage[]> {
    const params = new URLSearchParams({ project_id: String(projectId) })
    return array(await this.#request(`/api/pages?${params}`), 'pages').map(mapPage)
  }

  async getPage(identifier: string): Promise<LificPage | null> {
    try {
      return mapPage(await this.#request(`/api/pages/resolve/${encodeURIComponent(identifier)}`))
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) {
        return null
      }
      throw error
    }
  }

  async search(input: {
    query: string
    projectId?: number
    resultType?: 'issue' | 'page'
    limit?: number
  }): Promise<LificSearchResult[]> {
    const params = new URLSearchParams({ query: input.query, limit: String(input.limit ?? 50) })
    if (input.projectId !== undefined) {
      params.set('project_id', String(input.projectId))
    }
    if (input.resultType) {
      params.set('result_type', input.resultType)
    }
    return array(await this.#request(`/api/search?${params}`), 'search results').map(
      mapSearchResult
    )
  }

  async getBoard(projectId: number): Promise<Record<string, unknown>> {
    return object(
      await this.#request(`/api/projects/${encodeURIComponent(String(projectId))}/board`),
      'board'
    )
  }

  async linkIssues(source: string, target: string, relation: string): Promise<void> {
    await this.#request('/api/issues/link', {
      method: 'POST',
      body: JSON.stringify({ source, target, relation_type: relation })
    })
  }

  async unlinkIssues(source: string, target: string, _relation: string): Promise<void> {
    await this.#request('/api/issues/unlink', {
      method: 'POST',
      body: JSON.stringify({ source, target })
    })
  }
}
