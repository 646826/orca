import { CheckCircle2, FileText, MessageSquare } from 'lucide-react'
import type {
  LificComment,
  LificIssue,
  LificPage,
  LificPlan,
  LificSearchResult
} from '../../../../shared/lific/lific-types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { lificCopy } from './lific-integration-copy'

type Props = {
  profileId: string
  busy: boolean
  issues: LificIssue[]
  plans: LificPlan[]
  pages: LificPage[]
  searchResults: LificSearchResult[]
  issueRows: (LificIssue | LificSearchResult)[]
  selectedIssue: LificIssue | null
  comments: LificComment[]
  statusDraft: string
  onStatusDraftChange: (value: string) => void
  commentDraft: string
  onCommentDraftChange: (value: string) => void
  onOpenIssue: (identifier: string) => void
  onSaveStatus: () => void
  onAddComment: () => void
}

function issueSummary(issue: LificIssue): string {
  const status = issue.status?.trim()
  const priority =
    issue.priority === null || issue.priority === undefined ? '' : String(issue.priority)
  return [status, priority ? lificCopy.priority(priority) : ''].filter(Boolean).join(' · ')
}

export function LificTaskConsoleContent({
  profileId,
  busy,
  issues,
  plans,
  pages,
  searchResults,
  issueRows,
  selectedIssue,
  comments,
  statusDraft,
  onStatusDraftChange,
  commentDraft,
  onCommentDraftChange,
  onOpenIssue,
  onSaveStatus,
  onAddComment
}: Props): React.JSX.Element {
  return (
    <>
      <div className="grid gap-3 lg:grid-cols-[minmax(16rem,0.8fr)_minmax(20rem,1.2fr)]">
        <div className="max-h-[34rem] overflow-auto scrollbar-sleek rounded-md border border-border/50">
          <div className="border-b border-border/50 px-3 py-2 text-xs font-medium">
            {searchResults.length
              ? lificCopy.searchResults(searchResults.length)
              : lificCopy.issues(issues.length)}
          </div>
          {issueRows.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">{lificCopy.noMatchingIssues()}</p>
          ) : (
            <div className="divide-y divide-border/50">
              {issueRows.map((row) => {
                const identifier = 'identifier' in row ? row.identifier : null
                const title = row.title
                const summary =
                  'raw' in row && 'status' in row
                    ? issueSummary(row as LificIssue)
                    : (row as LificSearchResult).snippet
                if (!identifier) {
                  return null
                }
                return (
                  <button
                    key={identifier}
                    type="button"
                    className="w-full space-y-1 px-3 py-2 text-left hover:bg-muted/40"
                    onClick={() => void onOpenIssue(identifier)}
                  >
                    <div className="text-xs font-medium">
                      {identifier} · {title}
                    </div>
                    {summary ? (
                      <div className="line-clamp-2 text-[11px] text-muted-foreground">
                        {summary}
                      </div>
                    ) : null}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="space-y-3 rounded-md border border-border/50 p-3">
          {selectedIssue ? (
            <>
              <div>
                <div className="text-xs text-muted-foreground">{selectedIssue.identifier}</div>
                <h4 className="text-sm font-semibold">{selectedIssue.title}</h4>
                {selectedIssue.description ? (
                  <pre className="mt-2 max-h-48 overflow-auto scrollbar-sleek whitespace-pre-wrap text-xs font-sans text-muted-foreground">
                    {selectedIssue.description}
                  </pre>
                ) : null}
              </div>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <div className="space-y-1">
                  <Label htmlFor={`${profileId}-issue-status`}>{lificCopy.status()}</Label>
                  <Input
                    id={`${profileId}-issue-status`}
                    value={statusDraft}
                    onChange={(event) => onStatusDraftChange(event.target.value)}
                    placeholder={lificCopy.statusPlaceholder()}
                  />
                </div>
                <Button
                  className="self-end gap-1.5"
                  disabled={busy || !statusDraft.trim()}
                  onClick={() => void onSaveStatus()}
                >
                  <CheckCircle2 className="size-3.5" />
                  {lificCopy.update()}
                </Button>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-medium">
                  <MessageSquare className="size-3.5" />
                  {lificCopy.comments(comments.length)}
                </div>
                <div className="max-h-40 space-y-2 overflow-auto scrollbar-sleek">
                  {comments.map((comment) => (
                    <div
                      key={comment.id}
                      className="rounded border border-border/40 p-2 text-xs whitespace-pre-wrap"
                    >
                      {comment.content}
                    </div>
                  ))}
                </div>
                <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                  <Input
                    value={commentDraft}
                    onChange={(event) => onCommentDraftChange(event.target.value)}
                    placeholder={lificCopy.commentPlaceholder()}
                  />
                  <Button
                    variant="outline"
                    disabled={busy || !commentDraft.trim()}
                    onClick={() => void onAddComment()}
                  >
                    {lificCopy.comment()}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{lificCopy.selectIssue()}</p>
          )}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-border/50">
          <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2 text-xs font-medium">
            <CheckCircle2 className="size-3.5" />
            {lificCopy.plans(plans.length)}
          </div>
          <div className="max-h-44 divide-y divide-border/40 overflow-auto scrollbar-sleek">
            {plans.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">{lificCopy.noPlans()}</p>
            ) : (
              plans.map((plan) => (
                <div key={plan.id} className="px-3 py-2 text-xs">
                  <div className="font-medium">
                    {plan.identifier} · {plan.title}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {plan.status} · {lificCopy.topLevelSteps(plan.steps.length)}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="rounded-md border border-border/50">
          <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2 text-xs font-medium">
            <FileText className="size-3.5" />
            {lificCopy.pages(pages.length)}
          </div>
          <div className="max-h-44 divide-y divide-border/40 overflow-auto scrollbar-sleek">
            {pages.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">{lificCopy.noPages()}</p>
            ) : (
              pages.map((page) => (
                <div key={page.id} className="px-3 py-2 text-xs">
                  <div className="font-medium">
                    {page.identifier} · {page.title}
                  </div>
                  {page.content ? (
                    <div className="line-clamp-2 text-[11px] text-muted-foreground">
                      {page.content}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  )
}
