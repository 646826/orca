import { FolderKanban, LoaderCircle, RefreshCw, Search } from 'lucide-react'
import type { LificProject } from '../../../../shared/lific/lific-types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { lificCopy } from './lific-integration-copy'

type Props = {
  profileId: string
  disabled: boolean
  busy: boolean
  projects: LificProject[]
  projectIdentifier: string
  searchQuery: string
  onRefresh: () => void
  onProjectIdentifierChange: (value: string) => void
  onSearchQueryChange: (value: string) => void
  onSearch: () => void
}

export function LificTaskConsoleToolbar({
  profileId,
  disabled,
  busy,
  projects,
  projectIdentifier,
  searchQuery,
  onRefresh,
  onProjectIdentifierChange,
  onSearchQueryChange,
  onSearch
}: Props): React.JSX.Element {
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <FolderKanban className="size-4" />
            {lificCopy.taskConsoleTitle()}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{lificCopy.taskConsoleDescription()}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={disabled || busy}
          onClick={onRefresh}
          aria-label={lificCopy.refreshProjects()}
        >
          {busy ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </Button>
      </div>

      {disabled ? null : (
        <div className="grid gap-2 md:grid-cols-[minmax(12rem,0.7fr)_minmax(15rem,1fr)_auto]">
          <label className="space-y-1 text-xs">
            <span className="font-medium">{lificCopy.project()}</span>
            <select
              className="h-9 w-full rounded-md border bg-background px-2"
              value={projectIdentifier}
              onChange={(event) => onProjectIdentifierChange(event.target.value)}
            >
              {projects.length === 0 ? <option value="">{lificCopy.noProjects()}</option> : null}
              {projects.map((project) => (
                <option key={project.id} value={project.identifier}>
                  {project.identifier} · {project.name}
                </option>
              ))}
            </select>
          </label>
          <div className="space-y-1">
            <Label htmlFor={`${profileId}-task-search`}>{lificCopy.searchLabel()}</Label>
            <Input
              id={`${profileId}-task-search`}
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  onSearch()
                }
              }}
              placeholder={lificCopy.searchPlaceholder()}
            />
          </div>
          <Button
            className="self-end gap-1.5"
            variant="outline"
            disabled={busy}
            onClick={onSearch}
          >
            <Search className="size-3.5" />
            {lificCopy.search()}
          </Button>
        </div>
      )}
    </>
  )
}
