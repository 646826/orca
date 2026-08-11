import { Database, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react'
import type { LificHealthState } from '../../../../shared/lific/lific-types'
import { Button } from '../ui/button'
import { lificCopy } from './lific-integration-copy'
import { lificStatusText } from './lific-integration-status'

type Props = {
  executionHostId: string
  busy: boolean
  hasProfile: boolean
  health: LificHealthState | null
  preview: string
  onRefresh: () => void
}

export function LificIntegrationSummary({
  executionHostId,
  busy,
  hasProfile,
  health,
  preview,
  onRefresh
}: Props): React.JSX.Element {
  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Database className="size-4" />
            <h3 className="text-sm font-semibold">{lificCopy.brand()}</h3>
          </div>
          <p className="text-xs text-muted-foreground">{lificCopy.description()}</p>
          <p className="text-xs text-muted-foreground">
            {lificCopy.executionHost(executionHostId)}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={busy || !hasProfile}
          onClick={onRefresh}
          aria-label={lificCopy.refreshStatus()}
        >
          {busy ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </Button>
      </div>

      <div className="rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-3.5" />
          <span>{lificStatusText(health)}</span>
        </div>
      </div>

      {preview ? (
        <pre className="max-h-72 overflow-auto scrollbar-sleek rounded-md border bg-muted/20 p-3 text-[11px] whitespace-pre-wrap">
          {preview}
        </pre>
      ) : null}
    </>
  )
}
