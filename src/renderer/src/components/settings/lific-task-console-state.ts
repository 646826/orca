import type {
  LificComment,
  LificIssue,
  LificPage,
  LificPlan,
  LificProject,
  LificSearchResult
} from '../../../../shared/lific/lific-types'

export type LificTaskConsoleSnapshot = {
  issues: LificIssue[]
  plans: LificPlan[]
  pages: LificPage[]
}

export type LificTaskConsoleState = {
  projects: LificProject[]
  projectIdentifier: string
  snapshot: LificTaskConsoleSnapshot
  searchQuery: string
  searchResults: LificSearchResult[]
  selectedIssue: LificIssue | null
  comments: LificComment[]
  statusDraft: string
  commentDraft: string
  busy: boolean
  error: string | null
}

export function createLificTaskConsoleState(
  preferredProjectIdentifier?: string
): LificTaskConsoleState {
  return {
    projects: [],
    projectIdentifier: preferredProjectIdentifier ?? '',
    snapshot: { issues: [], plans: [], pages: [] },
    searchQuery: '',
    searchResults: [],
    selectedIssue: null,
    comments: [],
    statusDraft: '',
    commentDraft: '',
    busy: false,
    error: null
  }
}

export function reduceLificTaskConsoleState(
  state: LificTaskConsoleState,
  patch: Partial<LificTaskConsoleState>
): LificTaskConsoleState {
  return { ...state, ...patch }
}
