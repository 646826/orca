import { parentPort, workerData } from 'node:worker_threads'
import { z } from 'zod'
import { ConversationScratchOwner } from './conversation-scratch-owner'
import { ConversationReplayResourceLimit } from './conversation-replay-resource-limit'
import {
  ConversationScratchCommandSchema,
  assertScratchMessageBound,
  type ConversationScratchCommand
} from './conversation-scratch-protocol'

if (!parentPort) {
  throw new Error('Conversation scratch requires a worker thread')
}
const port = parentPort
const initialization = z.object({ directory: z.string().min(1) }).parse(workerData)
let owner: ConversationScratchOwner | undefined
let previousId = 0
function execute(command: ConversationScratchCommand): unknown {
  if (!owner) {
    throw new Error('Conversation scratch unavailable')
  }
  switch (command.command) {
    case 'open-replay':
      return owner.openReplay(command.pin)
    case 'append-replay':
      return owner.appendReplay(command.entries)
    case 'finish-replay':
      return owner.finishReplay()
    case 'replay-page':
      return owner.replayPage(command.after, command.limit, command.maxBytes)
    case 'close-replay':
      return owner.closeReplay()
    case 'open-history':
      return owner.openHistory()
    case 'begin-history-epoch':
      return owner.beginHistoryEpoch()
    case 'append-history':
      return owner.appendHistory(command.entries)
    case 'flush-history':
      return owner.flushHistory()
    case 'history-page':
      return owner.historyPage(command.input)
    case 'close':
      return owner.close()
  }
}
function failure(id: number, error: unknown): void {
  port.postMessage({
    id,
    ok: false,
    message: (error instanceof Error ? error.message : String(error)).slice(0, 2048),
    resourceLimit:
      error instanceof ConversationReplayResourceLimit ||
      (error instanceof RangeError && error.message.includes('resource limit'))
  })
}
try {
  owner = new ConversationScratchOwner(initialization.directory)
  port.postMessage({ id: 0, ok: true, value: null })
} catch (error) {
  failure(0, error)
  port.close()
}
port.on('message', (value: unknown) => {
  const id = z.object({ id: z.number().int().positive().safe() }).safeParse(value)
  const command = ConversationScratchCommandSchema.safeParse(value)
  if (!id.success || !command.success || id.data.id <= previousId) {
    failure(0, new Error('Invalid conversation scratch command'))
    port.close()
    return
  }
  previousId = id.data.id
  try {
    assertScratchMessageBound(value)
    const result = execute(command.data) ?? null
    const response = { id: id.data.id, ok: true, value: result }
    assertScratchMessageBound(response)
    port.postMessage(response)
    if (command.data.command === 'close') {
      port.close()
    }
  } catch (error) {
    failure(id.data.id, error)
  }
})
