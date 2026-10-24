export function createConversationCommitNotifier(closedSignal: AbortSignal) {
  const versions = new Map<string, number>()
  const listeners = new Set<(sessionId: string) => void>()
  const notifyJournalCommitted = (sessionId: string) => {
    versions.set(sessionId, (versions.get(sessionId) ?? 0) + 1)
    for (const listener of listeners) {
      listener(sessionId)
    }
  }
  const waitForChange = (sessionId: string, version: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        listeners.delete(changed)
        signal.removeEventListener('abort', aborted)
        closedSignal.removeEventListener('abort', closed)
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
      const changed = (id: string) => {
        if (id === sessionId) {
          finish()
        }
      }
      const aborted = () => finish(signal.reason)
      const closed = () => finish(closedSignal.reason)
      listeners.add(changed)
      signal.addEventListener('abort', aborted, { once: true })
      closedSignal.addEventListener('abort', closed, { once: true })
      if (signal.aborted) {
        aborted()
      } else if (closedSignal.aborted) {
        closed()
      } else if ((versions.get(sessionId) ?? 0) !== version) {
        finish()
      }
    })
  return {
    notifyJournalCommitted,
    waitForChange,
    revision: (id: string) => versions.get(id) ?? 0,
    clear: () => versions.clear()
  }
}
