import { useCallback, useEffect, useMemo, useReducer } from 'react'
import type { LificIssue, LificSearchResult } from '../../../../shared/lific/lific-types'
import {
  type RuntimeLificSettings,
  lificTaskAddComment,
  lificTaskComments,
  lificTaskIssue,
  lificTaskIssues,
  lificTaskPages,
  lificTaskPlans,
  lificTaskProjects,
  lificTaskSearch,
  lificTaskUpdateIssue
} from '../../runtime/runtime-lific-client'
import { LificTaskConsoleContent } from './LificTaskConsoleContent'
import { LificTaskConsoleToolbar } from './LificTaskConsoleToolbar'
import { lificCopy } from './lific-integration-copy'
import {
  createLificTaskConsoleState,
  reduceLificTaskConsoleState
} from './lific-task-console-state'

type Props = {
  settings: RuntimeLificSettings
  profileId: string
  preferredProjectIdentifier?: string | undefined
  disabled?: boolean
}

export function LificTaskConsole({
  settings,
  profileId,
  preferredProjectIdentifier,
  disabled = false
}: Props): React.JSX.Element {
  const [state, updateState] = useReducer(
    reduceLificTaskConsoleState,
    preferredProjectIdentifier,
    createLificTaskConsoleState
  )
  const {
    projects,
    projectIdentifier,
    snapshot,
    searchQuery,
    searchResults,
    selectedIssue,
    comments,
    statusDraft,
    commentDraft,
    busy,
    error
  } = state

  useEffect(() => {
    if (preferredProjectIdentifier?.trim()) {
      updateState({ projectIdentifier: preferredProjectIdentifier.trim() })
    }
  }, [preferredProjectIdentifier])

  const selectedProject = useMemo(
    () => projects.find((project) => project.identifier === projectIdentifier) ?? null,
    [projectIdentifier, projects]
  )

  const execute = useCallback(async <T,>(operation: () => Promise<T>): Promise<T | null> => {
    updateState({ busy: true, error: null })
    try {
      return await operation()
    } catch (cause) {
      updateState({ error: cause instanceof Error ? cause.message : String(cause) })
      return null
    } finally {
      updateState({ busy: false })
    }
  }, [])

  const loadProjects = useCallback(async (): Promise<void> => {
    const next = await execute(() => lificTaskProjects(settings, profileId))
    if (!next) {
      return
    }
    const preferred = preferredProjectIdentifier?.trim()
    const nextProjectIdentifier = next.some((project) => project.identifier === projectIdentifier)
      ? projectIdentifier
      : preferred && next.some((project) => project.identifier === preferred)
        ? preferred
        : (next[0]?.identifier ?? '')
    updateState({ projects: next, projectIdentifier: nextProjectIdentifier })
  }, [execute, preferredProjectIdentifier, profileId, projectIdentifier, settings])

  const loadProject = useCallback(async (): Promise<void> => {
    if (!projectIdentifier) {
      return
    }
    const project = projects.find((entry) => entry.identifier === projectIdentifier)
    if (!project) {
      return
    }
    const next = await execute(async () => {
      const [issues, plans, pages] = await Promise.all([
        lificTaskIssues(settings, { profileId, project: project.identifier, limit: 100 }),
        lificTaskPlans(settings, { profileId, projectId: project.id }),
        lificTaskPages(settings, profileId, project.id)
      ])
      return { issues, plans, pages }
    })
    if (!next) {
      return
    }
    const selectedIssueMissing =
      selectedIssue && !next.issues.some((issue) => issue.identifier === selectedIssue.identifier)
    updateState({
      snapshot: next,
      searchResults: [],
      ...(selectedIssueMissing ? { selectedIssue: null, comments: [] } : {})
    })
  }, [execute, profileId, projectIdentifier, projects, selectedIssue, settings])

  useEffect(() => {
    if (!disabled && projects.length === 0) {
      void loadProjects()
    }
  }, [disabled, loadProjects, projects.length])

  useEffect(() => {
    if (!disabled && selectedProject) {
      void loadProject()
    }
  }, [disabled, loadProject, selectedProject])

  const runSearch = async (): Promise<void> => {
    const query = searchQuery.trim()
    if (!query) {
      updateState({ searchResults: [] })
      await loadProject()
      return
    }
    const next = await execute(() =>
      lificTaskSearch(settings, {
        profileId,
        query,
        ...(selectedProject ? { projectId: selectedProject.id } : {}),
        limit: 100
      })
    )
    if (next) {
      updateState({ searchResults: next })
    }
  }

  const openIssue = async (identifier: string): Promise<void> => {
    const result = await execute(async () => {
      const [issue, nextComments] = await Promise.all([
        lificTaskIssue(settings, profileId, identifier),
        lificTaskComments(settings, profileId, identifier)
      ])
      return { issue, comments: nextComments }
    })
    if (!result) {
      return
    }
    updateState({
      selectedIssue: result.issue,
      comments: result.comments,
      statusDraft: result.issue.status ?? ''
    })
  }

  const saveStatus = async (): Promise<void> => {
    if (!selectedIssue || !statusDraft.trim()) {
      return
    }
    const updated = await execute(() =>
      lificTaskUpdateIssue(settings, {
        profileId,
        identifier: selectedIssue.identifier,
        update: { status: statusDraft.trim() }
      })
    )
    if (!updated) {
      return
    }
    updateState({
      selectedIssue: updated,
      snapshot: {
        ...snapshot,
        issues: snapshot.issues.map((issue) =>
          issue.identifier === updated.identifier ? updated : issue
        )
      }
    })
  }

  const addComment = async (): Promise<void> => {
    if (!selectedIssue || !commentDraft.trim()) {
      return
    }
    const created = await execute(() =>
      lificTaskAddComment(settings, {
        profileId,
        identifier: selectedIssue.identifier,
        content: commentDraft.trim()
      })
    )
    if (!created) {
      return
    }
    updateState({ comments: [...comments, created], commentDraft: '' })
  }

  const issueRows: LificIssue[] | LificSearchResult[] = searchResults.length
    ? searchResults.filter((result) => result.resultType === 'issue' && result.identifier)
    : snapshot.issues

  return (
    <section className="space-y-3 rounded-md border border-border/50 p-3">
      <LificTaskConsoleToolbar
        profileId={profileId}
        disabled={disabled}
        busy={busy}
        projects={projects}
        projectIdentifier={projectIdentifier}
        searchQuery={searchQuery}
        onRefresh={() => void loadProjects()}
        onProjectIdentifierChange={(value) => updateState({ projectIdentifier: value })}
        onSearchQueryChange={(value) => updateState({ searchQuery: value })}
        onSearch={() => void runSearch()}
      />

      {disabled ? (
        <p className="text-xs text-muted-foreground">{lificCopy.saveAndConnect()}</p>
      ) : (
        <>
          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}

          <LificTaskConsoleContent
            profileId={profileId}
            busy={busy}
            issues={snapshot.issues}
            plans={snapshot.plans}
            pages={snapshot.pages}
            searchResults={searchResults}
            issueRows={issueRows}
            selectedIssue={selectedIssue}
            comments={comments}
            statusDraft={statusDraft}
            onStatusDraftChange={(value) => updateState({ statusDraft: value })}
            commentDraft={commentDraft}
            onCommentDraftChange={(value) => updateState({ commentDraft: value })}
            onOpenIssue={(identifier) => void openIssue(identifier)}
            onSaveStatus={() => void saveStatus()}
            onAddComment={() => void addComment()}
          />
        </>
      )}
    </section>
  )
}
