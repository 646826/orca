import type { CommandHandler } from '../dispatch'
import { LIFIC_ADMIN_HANDLER_ENTRIES } from './lific-admin-handlers'
import { LIFIC_TASK_HANDLER_ENTRIES } from './lific-task-handlers'

export const LIFIC_HANDLERS: Record<string, CommandHandler> = {
  ...LIFIC_ADMIN_HANDLER_ENTRIES,
  ...LIFIC_TASK_HANDLER_ENTRIES
}
