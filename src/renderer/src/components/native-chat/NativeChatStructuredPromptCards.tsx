import type { ComponentProps } from 'react'
import { agentSessionPromptQuestions } from '../../../../shared/agent-session-question-answer'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatStructuredQuestionCard } from './NativeChatStructuredQuestionCard'
import { chatApprovalFromJournal } from './native-chat-interactive-prompt'
import type { useStructuredPromptResponseHold } from './use-structured-prompt-response-hold'

type PromptResponse = ReturnType<typeof useStructuredPromptResponseHold>

/** The active native prompt keeps its original item/revision and response hold. */
export function NativeChatStructuredPromptCards(props: {
  prompt: Parameters<PromptResponse['respond']>[0] | null
  response: PromptResponse
  onCancel: () => void
  shouldFocus: boolean
  answerInputRef: ComponentProps<typeof NativeChatStructuredQuestionCard>['answerInputRef']
  onLinkClick: ComponentProps<typeof NativeChatApprovalCard>['onLinkClick']
}): React.JSX.Element | null {
  const { prompt, response } = props
  if (!prompt) {
    return null
  }
  if (prompt.body.kind === 'approval') {
    const approval = chatApprovalFromJournal(prompt.body)
    return approval ? (
      <NativeChatApprovalCard
        key={`${prompt.itemId}:${prompt.revision}`}
        approval={approval}
        onChoose={(optionId) => void response.respond(prompt, { kind: 'option', optionId })}
        isSubmitting={response.holds(prompt)}
        onCancel={props.onCancel}
        shouldFocus={props.shouldFocus}
        onLinkClick={props.onLinkClick}
        allowFileUriLinks={props.onLinkClick !== undefined}
      />
    ) : null
  }
  return prompt.body.kind === 'question' ? (
    <NativeChatStructuredQuestionCard
      key={`${prompt.itemId}:${prompt.revision}`}
      questions={agentSessionPromptQuestions(prompt.body)}
      onAnswer={(answer) => void response.respond(prompt, answer)}
      isSubmitting={response.holds(prompt)}
      onCancel={props.onCancel}
      shouldFocus={props.shouldFocus}
      answerInputRef={props.answerInputRef}
    />
  ) : null
}
