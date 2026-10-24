import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import type { ConversationSurfaceSnapshot } from '../../../../shared/conversation-surface-rpc'
import { structuredSessionOperationId } from './structured-agent-session-operation-id'

const ArchiveJob = z
  .object({ operationKey: z.string(), phase: z.enum(['inventory', 'cleanup', 'complete']) })
  .nullable()
export function NativeChatConversationArchive({
  snapshot,
  busy,
  request,
  run
}: {
  snapshot: ConversationSurfaceSnapshot
  busy: boolean
  request: (method: string, params: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
  run: (action: () => Promise<void>) => Promise<void>
}) {
  const conversation = snapshot.conversation
  const [generation, setGeneration] = useState(conversation.contextGeneration - 1)
  const [confirming, setConfirming] = useState(false)
  const [job, setJob] = useState<z.infer<typeof ArchiveJob>>(null)
  const [ready, setReady] = useState(false)
  const [revision, setRevision] = useState(0)
  const lifetime = useRef<AbortController | null>(null)
  const operation = useRef(structuredSessionOperationId())
  const valid =
    Number.isSafeInteger(generation) &&
    generation > 0 &&
    generation < conversation.contextGeneration
  useEffect(() => {
    const abort = new AbortController()
    lifetime.current = abort
    setReady(false)
    setJob(null)
    setConfirming(false)
    if (valid) {
      void request(
        'conversation.archiveStatus',
        { conversationId: conversation.conversationId, contextGeneration: generation },
        { signal: abort.signal }
      )
        .then((value) => {
          const parsed = ArchiveJob.parse(value)
          if (!abort.signal.aborted) {
            setJob(parsed)
            setReady(true)
          }
        })
        .catch(() => {})
    }
    return () => {
      abort.abort()
    }
  }, [request, conversation.conversationId, generation, valid, revision])
  const remove = () =>
    run(async () => {
      const token = lifetime.current
      await request('conversation.deleteArchive', {
        conversationId: conversation.conversationId,
        expectedRevision: conversation.revision,
        contextGeneration: generation,
        clientOperationId: operation.current
      })
      if (token && !token.signal.aborted && lifetime.current === token) {
        setRevision((value) => value + 1)
      }
    })
  const cleanup = () =>
    run(async () => {
      if (!job) {
        return
      }
      const token = lifetime.current
      await request('conversation.cleanupArchive', {
        conversationId: conversation.conversationId,
        operationKey: job.operationKey
      })
      if (token && !token.signal.aborted && lifetime.current === token) {
        setRevision((value) => value + 1)
      }
    })
  return (
    <div className="space-y-2 rounded-md border border-border bg-card p-3 text-xs text-card-foreground">
      <label className="flex items-center gap-2">
        {translate('components.native-chat.agentSwitch.archiveVersion', 'Archived context version')}
        <Input
          type="number"
          min={1}
          max={conversation.contextGeneration - 1}
          value={generation}
          disabled={busy}
          onChange={(event) => {
            operation.current = structuredSessionOperationId()
            setGeneration(Number(event.target.value))
          }}
          className="h-8 w-24"
        />
      </label>
      <p className="text-muted-foreground">
        {translate(
          'components.native-chat.agentSwitch.archiveDeleteDisclosure',
          'Remove this archived context from Orca and release its dedicated retained payloads. Shared history needed by another context may remain. Provider data is not erased.'
        )}
      </p>
      {!ready ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !valid}
          onClick={() => setRevision((value) => value + 1)}
        >
          {translate('components.native-chat.agentSwitch.retryArchiveRead', 'Read archive status')}
        </Button>
      ) : job ? (
        <>
          <p>
            {job.phase === 'complete'
              ? translate(
                  'components.native-chat.agentSwitch.archiveRemoved',
                  'Archive removed. Shared evidence may remain.'
                )
              : translate(
                  'components.native-chat.agentSwitch.archiveCleanupPending',
                  'Archive hidden; retained payload cleanup is pending.'
                )}
          </p>
          {job.phase !== 'complete' ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void cleanup()}>
              {translate(
                'components.native-chat.agentSwitch.continueArchiveCleanup',
                'Continue archive cleanup'
              )}
            </Button>
          ) : null}
        </>
      ) : confirming ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || Boolean(conversation.pendingOperationKey)}
            onClick={() => void remove()}
          >
            {translate(
              'components.native-chat.agentSwitch.confirmArchiveDelete',
              'Delete this archived context'
            )}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
            {translate('components.native-chat.agentSwitch.keepArchive', 'Keep archive')}
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || Boolean(conversation.pendingOperationKey)}
          onClick={() => setConfirming(true)}
        >
          {translate('components.native-chat.agentSwitch.deleteArchive', 'Delete archive')}
        </Button>
      )}
    </div>
  )
}
