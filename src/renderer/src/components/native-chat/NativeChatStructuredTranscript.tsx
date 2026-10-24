import { useMemo, type ComponentProps } from 'react'
import { NativeChatMessageList } from './NativeChatMessageList'
import { NativeChatRewindContext } from './native-chat-rewind-context'
import {
  NativeChatOrcaStopContext,
  type NativeChatOrcaStopView
} from './native-chat-orca-stop-context'
import {
  NativeChatClaudeSignInContext,
  type NativeChatClaudeSignIn
} from './native-chat-claude-sign-in'
import type { useStructuredAgentSession } from './use-structured-agent-session'

type ListProps = ComponentProps<typeof NativeChatMessageList>
type Props = Pick<
  ListProps,
  | 'session'
  | 'ref'
  | 'isVisible'
  | 'awaitingInput'
  | 'stopping'
  | 'onLinkClick'
  | 'allowFileUriLinks'
  | 'runtimeContext'
  | 'deliveryNotices'
> & {
  controller: ReturnType<typeof useStructuredAgentSession>
  readOnly: boolean
  stopView: NativeChatOrcaStopView
  signIn: NativeChatClaudeSignIn | null
}

export function NativeChatStructuredTranscript({
  controller,
  readOnly,
  stopView,
  signIn,
  ...list
}: Props): React.JSX.Element {
  const visibleStop = useMemo(
    () =>
      readOnly
        ? {
            ...stopView,
            continueAvailable: false,
            offeredTurnItemId: null,
            usageLimitTurnItemId: null
          }
        : stopView,
    [readOnly, stopView]
  )
  return (
    <NativeChatRewindContext.Provider value={readOnly ? undefined : controller.rewind.surface}>
      <NativeChatOrcaStopContext.Provider value={visibleStop}>
        <NativeChatClaudeSignInContext.Provider value={readOnly ? null : signIn}>
          <NativeChatMessageList
            {...list}
            journalItems={readOnly ? undefined : controller.journalItems}
            journalSubmissions={readOnly ? undefined : controller.submissions}
            journalLatestTurn={readOnly ? undefined : controller.latestTurn}
            journalHostWork={readOnly ? undefined : controller.hostWork}
            subagentRoster={readOnly ? undefined : controller.subagentRoster}
            railOutline={readOnly ? undefined : controller.railOutline}
            isWorking={controller.isWorking}
            expandSignal={false}
            workingStartedAt={controller.workingStartedAt}
            settledTurns={readOnly ? undefined : controller.settledTurns}
            turnActivity={controller.turnActivity}
            deliveryNotices={readOnly ? undefined : list.deliveryNotices}
          />
        </NativeChatClaudeSignInContext.Provider>
      </NativeChatOrcaStopContext.Provider>
    </NativeChatRewindContext.Provider>
  )
}
