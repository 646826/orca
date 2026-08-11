import { readFileSync } from 'node:fs'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { formatLificResult, positiveLificNumber } from './lific-handler-utils'

export const LIFIC_TASK_HANDLER_ENTRIES: Record<string, CommandHandler> = {
  'lific project list': async ({ flags, client, json }) => {
    printResult(
      await client.call('lific.task.projects', {
        profileId: getRequiredStringFlag(flags, 'profile')
      }),
      json,
      formatLificResult
    )
  },
  'lific issue list': async ({ flags, client, json }) => {
    printResult(
      await client.call('lific.task.issues', {
        profileId: getRequiredStringFlag(flags, 'profile'),
        project: getRequiredStringFlag(flags, 'project'),
        query: getOptionalStringFlag(flags, 'query'),
        limit: getOptionalPositiveIntegerFlag(flags, 'limit')
      }),
      json,
      formatLificResult
    )
  },
  'lific issue show': async ({ flags, client, json }) => {
    printResult(
      await client.call('lific.task.issue', {
        profileId: getRequiredStringFlag(flags, 'profile'),
        identifier: getRequiredStringFlag(flags, 'issue')
      }),
      json,
      formatLificResult
    )
  },
  'lific issue update': async ({ flags, client, json }) => {
    const update: Record<string, unknown> = {}
    for (const key of ['status', 'title', 'description', 'priority'] as const) {
      const value = getOptionalStringFlag(flags, key)
      if (value !== undefined) {
        update[key] = value
      }
    }
    if (Object.keys(update).length === 0) {
      throw new Error('At least one update field is required')
    }
    printResult(
      await client.call('lific.task.issue.update', {
        profileId: getRequiredStringFlag(flags, 'profile'),
        identifier: getRequiredStringFlag(flags, 'issue'),
        update
      }),
      json,
      formatLificResult
    )
  },
  'lific comment list': async ({ flags, client, json }) => {
    printResult(
      await client.call('lific.task.comments', {
        profileId: getRequiredStringFlag(flags, 'profile'),
        identifier: getRequiredStringFlag(flags, 'issue')
      }),
      json,
      formatLificResult
    )
  },
  'lific comment add': async ({ flags, client, json }) => {
    const body =
      flags.get('stdin') === true
        ? readFileSync(0, 'utf8').trim()
        : getRequiredStringFlag(flags, 'body')
    if (!body) {
      throw new Error('Comment body is empty')
    }
    printResult(
      await client.call('lific.task.comment.add', {
        profileId: getRequiredStringFlag(flags, 'profile'),
        identifier: getRequiredStringFlag(flags, 'issue'),
        content: body
      }),
      json,
      formatLificResult
    )
  },
  'lific plan list': async ({ flags, client, json }) => {
    printResult(
      await client.call('lific.task.plans', {
        profileId: getRequiredStringFlag(flags, 'profile'),
        projectId: positiveLificNumber(flags, 'project-id'),
        status: getOptionalStringFlag(flags, 'status')
      }),
      json,
      formatLificResult
    )
  },
  'lific plan show': async ({ flags, client, json }) => {
    printResult(
      await client.call('lific.task.plan', {
        profileId: getRequiredStringFlag(flags, 'profile'),
        identifier: getRequiredStringFlag(flags, 'plan')
      }),
      json,
      formatLificResult
    )
  },
  'lific plan-step set': async ({ flags, client, json }) => {
    const update: Record<string, unknown> = {}
    const done = getOptionalStringFlag(flags, 'done')
    if (done !== undefined) {
      if (!['true', 'false'].includes(done)) {
        throw new Error('--done must be true or false')
      }
      update.done = done === 'true'
    }
    for (const key of ['title', 'description'] as const) {
      const value = getOptionalStringFlag(flags, key)
      if (value !== undefined) {
        update[key] = value
      }
    }
    if (Object.keys(update).length === 0) {
      throw new Error('At least one step update is required')
    }
    printResult(
      await client.call('lific.task.plan-step.update', {
        profileId: getRequiredStringFlag(flags, 'profile'),
        planId: positiveLificNumber(flags, 'plan-id'),
        stepId: positiveLificNumber(flags, 'step-id'),
        update
      }),
      json,
      formatLificResult
    )
  },
  'lific page list': async ({ flags, client, json }) => {
    printResult(
      await client.call('lific.task.pages', {
        profileId: getRequiredStringFlag(flags, 'profile'),
        projectId: positiveLificNumber(flags, 'project-id')
      }),
      json,
      formatLificResult
    )
  },
  'lific page show': async ({ flags, client, json }) => {
    printResult(
      await client.call('lific.task.page', {
        profileId: getRequiredStringFlag(flags, 'profile'),
        identifier: getRequiredStringFlag(flags, 'page')
      }),
      json,
      formatLificResult
    )
  },
  'lific search': async ({ flags, client, json }) => {
    const resultType = getOptionalStringFlag(flags, 'type')
    if (resultType !== undefined && resultType !== 'issue' && resultType !== 'page') {
      throw new Error('--type must be issue or page')
    }
    printResult(
      await client.call('lific.task.search', {
        profileId: getRequiredStringFlag(flags, 'profile'),
        query: getRequiredStringFlag(flags, 'query'),
        projectId: getOptionalPositiveIntegerFlag(flags, 'project-id'),
        resultType,
        limit: getOptionalPositiveIntegerFlag(flags, 'limit')
      }),
      json,
      formatLificResult
    )
  },
  'lific board': async ({ flags, client, json }) => {
    printResult(
      await client.call('lific.task.board', {
        profileId: getRequiredStringFlag(flags, 'profile'),
        projectId: positiveLificNumber(flags, 'project-id')
      }),
      json,
      formatLificResult
    )
  },
  'lific relation add': async ({ flags, client, json }) => {
    printResult(
      await client.call('lific.task.relation.link', {
        profileId: getRequiredStringFlag(flags, 'profile'),
        source: getRequiredStringFlag(flags, 'source'),
        target: getRequiredStringFlag(flags, 'target'),
        relation: getRequiredStringFlag(flags, 'type')
      }),
      json,
      formatLificResult
    )
  },
  'lific relation remove': async ({ flags, client, json }) => {
    printResult(
      await client.call('lific.task.relation.unlink', {
        profileId: getRequiredStringFlag(flags, 'profile'),
        source: getRequiredStringFlag(flags, 'source'),
        target: getRequiredStringFlag(flags, 'target'),
        relation: getRequiredStringFlag(flags, 'type')
      }),
      json,
      formatLificResult
    )
  },
  'lific activity': async ({ flags, client, json }) => {
    printResult(
      await client.call('lific.task.activity', {
        profileId: getRequiredStringFlag(flags, 'profile'),
        projectId: positiveLificNumber(flags, 'project-id'),
        limit: getOptionalPositiveIntegerFlag(flags, 'limit')
      }),
      json,
      formatLificResult
    )
  }
}
