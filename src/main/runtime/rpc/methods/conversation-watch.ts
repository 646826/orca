import type { ConversationInvalidation } from '../../../../shared/conversation-surface-rpc'

/** Polling is a refresh hint; every read and mutation still checks host authority. */
export function watchConversationChanges(input: {
  signal: AbortSignal
  read: () => { token: string; state: ConversationInvalidation }
  emit: (state: ConversationInvalidation) => void
}): Promise<void> {
  if (input.signal.aborted) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    let previous: string | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const close = () => {
      clearTimeout(timer)
      input.signal.removeEventListener('abort', close)
      resolve()
    }
    const poll = () => {
      if (input.signal.aborted) {
        close()
        return
      }
      try {
        const current = input.read()
        if (current.token !== previous) {
          previous = current.token
          input.emit(current.state)
        }
        if (!input.signal.aborted) {
          timer = setTimeout(poll, 1000)
        } else {
          close()
        }
      } catch (error) {
        clearTimeout(timer)
        input.signal.removeEventListener('abort', close)
        reject(error)
      }
    }
    input.signal.addEventListener('abort', close, { once: true })
    poll()
  })
}
