import { Plug, Unplug } from 'lucide-react'
import { Button } from '../ui/button'
import { lificCopy } from './lific-integration-copy'

type Props = {
  busy: boolean
  hasProfile: boolean
  onSave: () => void
  onPreview: () => void
  onConnect: () => void
  onReconnect: () => void
  onDisconnect: () => void
  onUpdateAgentsMd: () => void
}

export function LificIntegrationActions({
  busy,
  hasProfile,
  onSave,
  onPreview,
  onConnect,
  onReconnect,
  onDisconnect,
  onUpdateAgentsMd
}: Props): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={busy} onClick={onSave}>
        {lificCopy.save()}
      </Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={onPreview}>
        {lificCopy.preview()}
      </Button>
      <Button size="sm" className="gap-1.5" disabled={busy} onClick={onConnect}>
        <Plug className="size-3.5" />
        {lificCopy.connect()}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={busy || !hasProfile}
        onClick={onReconnect}
      >
        {lificCopy.reconnect()}
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        disabled={busy || !hasProfile}
        onClick={onDisconnect}
      >
        <Unplug className="size-3.5" />
        {lificCopy.disconnect()}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={busy || !hasProfile}
        onClick={onUpdateAgentsMd}
      >
        {lificCopy.updateAgentsMd()}
      </Button>
    </div>
  )
}
