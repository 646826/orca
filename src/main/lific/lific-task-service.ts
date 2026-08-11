import type {
  LificActivityFeed,
  LificComment,
  LificIssue,
  LificPage,
  LificPlan,
  LificProject,
  LificSearchResult
} from '../../shared/lific/lific-types'

export type LificTaskClient = {
  health(): Promise<boolean>
  listProjects(): Promise<LificProject[]>
  listIssues(input: { projectId: number; limit?: number }): Promise<LificIssue[]>
  getIssue(identifier: string): Promise<LificIssue | null>
  updateIssue(issue: LificIssue, update: Record<string, unknown>): Promise<LificIssue>
  listComments(issue: LificIssue): Promise<LificComment[]>
  addComment(issue: LificIssue, content: string): Promise<LificComment>
  listPlans(projectId: number, status?: string): Promise<LificPlan[]>
  getPlan(identifier: string): Promise<LificPlan | null>
  updatePlanStep(
    planId: number,
    stepId: number,
    update: Record<string, unknown>
  ): Promise<LificPlan>
  listProjectActivity(projectId: number, limit?: number): Promise<LificActivityFeed>
  listPages(projectId: number): Promise<LificPage[]>
  getPage(identifier: string): Promise<LificPage | null>
  search(input: {
    query: string
    projectId?: number
    resultType?: 'issue' | 'page'
    limit?: number
  }): Promise<LificSearchResult[]>
  getBoard(projectId: number): Promise<Record<string, unknown>>
  linkIssues(source: string, target: string, relation: string): Promise<void>
  unlinkIssues(source: string, target: string, relation: string): Promise<void>
}

export class LificTaskService {
  readonly #client: LificTaskClient

  constructor(client: LificTaskClient) {
    this.#client = client
  }

  async status(): Promise<{ connected: boolean }> {
    return { connected: await this.#client.health() }
  }

  listProjects(): Promise<LificProject[]> {
    return this.#client.listProjects()
  }

  async listIssues(input: {
    project: string
    limit?: number
    query?: string
  }): Promise<LificIssue[]> {
    const project = (await this.#client.listProjects()).find(
      (entry) => entry.identifier === input.project
    )
    if (!project) {
      throw new Error(`Lific project '${input.project}' was not found`)
    }

    const query = input.query?.trim()
    if (!query) {
      return this.#client.listIssues({
        projectId: project.id,
        ...(input.limit !== undefined ? { limit: input.limit } : {})
      })
    }

    const results = await this.#client.search({
      query,
      projectId: project.id,
      resultType: 'issue',
      ...(input.limit !== undefined ? { limit: input.limit } : {})
    })
    const identifiers = [
      ...new Set(
        results
          .map((result) => result.identifier)
          .filter((identifier): identifier is string => typeof identifier === 'string')
      )
    ]
    const issues = await Promise.all(
      identifiers.map((identifier) => this.#client.getIssue(identifier))
    )
    return issues.filter((issue): issue is LificIssue => issue !== null)
  }

  async getIssue(identifier: string): Promise<LificIssue> {
    const issue = await this.#client.getIssue(identifier)
    if (!issue) {
      throw new Error(`Lific issue '${identifier}' was not found`)
    }
    return issue
  }

  async updateIssue(identifier: string, update: Record<string, unknown>): Promise<LificIssue> {
    return this.#client.updateIssue(await this.getIssue(identifier), update)
  }

  async listComments(identifier: string): Promise<LificComment[]> {
    return this.#client.listComments(await this.getIssue(identifier))
  }

  async addComment(identifier: string, content: string): Promise<LificComment> {
    const trimmed = content.trim()
    if (!trimmed) {
      throw new Error('Lific comment content cannot be empty')
    }
    return this.#client.addComment(await this.getIssue(identifier), trimmed)
  }

  listPlans(projectId: number, status?: string): Promise<LificPlan[]> {
    return this.#client.listPlans(projectId, status)
  }

  async getPlan(identifier: string): Promise<LificPlan> {
    const plan = await this.#client.getPlan(identifier)
    if (!plan) {
      throw new Error(`Lific plan '${identifier}' was not found`)
    }
    return plan
  }

  updatePlanStepById(
    planId: number,
    stepId: number,
    update: Record<string, unknown>
  ): Promise<LificPlan> {
    return this.#client.updatePlanStep(planId, stepId, update)
  }

  async findActivePlan(projectIdentifier: string): Promise<LificPlan | null> {
    const project = (await this.#client.listProjects()).find(
      (entry) => entry.identifier === projectIdentifier
    )
    if (!project) {
      throw new Error(`Lific project '${projectIdentifier}' was not found`)
    }
    const plans = await this.#client.listPlans(project.id, 'active')
    return plans[0] ?? null
  }

  async updatePlanStep(
    planIdentifier: string,
    stepId: number,
    update: Record<string, unknown>
  ): Promise<LificPlan> {
    const plan = await this.#client.getPlan(planIdentifier)
    if (!plan) {
      throw new Error(`Lific plan '${planIdentifier}' was not found`)
    }
    return this.#client.updatePlanStep(plan.id, stepId, update)
  }

  listProjectActivity(projectId: number, limit?: number): Promise<LificActivityFeed> {
    return this.#client.listProjectActivity(projectId, limit)
  }

  listPages(projectId: number): Promise<LificPage[]> {
    return this.#client.listPages(projectId)
  }

  async getPage(identifier: string): Promise<LificPage> {
    const page = await this.#client.getPage(identifier)
    if (!page) {
      throw new Error(`Lific page '${identifier}' was not found`)
    }
    return page
  }

  async search(input: {
    query: string
    projectId?: number
    resultType?: 'issue' | 'page'
    limit?: number
  }): Promise<LificSearchResult[]> {
    const query = input.query.trim()
    if (!query) {
      throw new Error('Lific search query cannot be empty')
    }
    return await this.#client.search({ ...input, query })
  }

  getBoard(projectId: number): Promise<Record<string, unknown>> {
    return this.#client.getBoard(projectId)
  }

  linkIssues(source: string, target: string, relation: string): Promise<void> {
    return this.#client.linkIssues(source, target, relation)
  }

  unlinkIssues(source: string, target: string, relation: string): Promise<void> {
    return this.#client.unlinkIssues(source, target, relation)
  }
}
