import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { agentSessionPromptQuestions } from '../../../../shared/agent-session-question-answer'
import { translate } from '@/i18n/i18n'
import { useConversationCandidatePrompts } from './use-conversation-candidate-prompts'
import { useStructuredPromptResponseHold } from './use-structured-prompt-response-hold'
import { chatApprovalFromJournal } from './native-chat-interactive-prompt'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatStructuredQuestionCard } from './NativeChatStructuredQuestionCard'

export function NativeChatConversationCandidatePrompts(props: {
  sessionId: string
  target: RuntimeClientTarget
  agentLabel: string
  isVisible: boolean
}) {
  const candidate = useConversationCandidatePrompts(props)
  const response = useStructuredPromptResponseHold(candidate.respond)
  const prompt = candidate.prompts[0]
  if (!prompt) {
    return null
  }
  return (
    <section
      aria-label={translate(
        'components.native-chat.agentSwitch.candidatePrompt',
        'Selected agent {{agent}} needs a response before switching',
        { agent: props.agentLabel }
      )}
    >
      <p className="px-3 py-2 text-xs text-muted-foreground">
        {translate(
          'components.native-chat.agentSwitch.candidatePrompt',
          'Selected agent {{agent}} needs a response before switching',
          { agent: props.agentLabel }
        )}
      </p>
      {prompt.body.kind === 'approval' ? (
        <NativeChatApprovalCard
          approval={chatApprovalFromJournal(prompt.body)}
          onChoose={(optionId) => {
            void response.respond(prompt, { kind: 'option', optionId })
          }}
          isSubmitting={response.holds(prompt)}
          onCancel={() => {
            void candidate.cancel(prompt)
          }}
          shouldFocus={false}
        />
      ) : (
        <NativeChatStructuredQuestionCard
          questions={agentSessionPromptQuestions(prompt.body)}
          onAnswer={(answer) => {
            void response.respond(prompt, answer)
          }}
          isSubmitting={response.holds(prompt)}
          onCancel={() => {
            void candidate.cancel(prompt)
          }}
          shouldFocus={false}
        />
      )}
    </section>
  )
}
