import { useEffect, useRef } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AgentSessionPromptResponse } from '../../../../shared/agent-session-question-answer'
import { useStructuredAgentSessionRead } from './use-structured-agent-session-read'
import {
  useStructuredAgentSessionMutate,
  type StructuredAgentSessionAction,
  type StructuredAgentSessionMutate
} from './use-structured-agent-session-mutate'
import {
  pendingStructuredSessionPrompts,
  type StructuredPromptItem
} from './structured-agent-session-message-projection'
import {
  respondToStructuredAgentSessionPrompt,
  cancelStructuredAgentSessionPrompt
} from './structured-agent-session-prompt-response'

/** Read and original-fence prompt responses only: no sends, options, launch or draft ownership. */
export function useConversationCandidatePrompts(input: {
  sessionId: string
  target: RuntimeClientTarget
  isVisible: boolean
}) {
  const read = useStructuredAgentSessionRead({
    sessionId: input.sessionId,
    target: input.target,
    isVisible: input.isVisible,
    isViewed: false
  })
  const lifetime = useRef({ mounted: false, generation: 0 })
  useEffect(() => {
    lifetime.current = { mounted: true, generation: lifetime.current.generation + 1 }
    return () => {
      lifetime.current = { mounted: false, generation: lifetime.current.generation + 1 }
    }
  }, [])
  const eligible = useRef(false)
  eligible.current = read.readCurrent && input.isVisible
  const scope = JSON.stringify([input.target, input.sessionId])
  const admission = useRef({
    scope,
    fence: read.state.fence,
    eligible: eligible.current,
    generation: 0
  })
  if (
    admission.current.scope !== scope ||
    admission.current.fence !== read.state.fence ||
    admission.current.eligible !== eligible.current
  ) {
    admission.current = {
      scope,
      fence: read.state.fence,
      eligible: eligible.current,
      generation: admission.current.generation + 1
    }
  }
  const admissionGeneration = admission.current.generation
  const current = useRef(scope)
  current.current = scope
  const stateRef = useRef(read.state)
  stateRef.current = read.state
  const { admit } = useStructuredAgentSessionMutate({
    sessionId: input.sessionId,
    target: input.target,
    stateRef,
    enabled: read.readCurrent && input.isVisible
  })
  const prompts =
    read.readCurrent && read.state.actionablePromptIds
      ? pendingStructuredSessionPrompts({
          journalItems: read.state.items,
          currentRequests: read.state.currentRequests,
          actionablePromptIds: read.state.actionablePromptIds
        })
      : []
  const latest = useRef(prompts)
  latest.current = prompts
  const valid = (item: StructuredPromptItem) =>
    lifetime.current.mounted &&
    admission.current.generation === admissionGeneration &&
    eligible.current &&
    current.current === scope &&
    stateRef.current.fence === read.state.fence &&
    latest.current.some(
      (prompt) => prompt.itemId === item.itemId && prompt.revision === item.revision
    )
  function guardedAction(item: StructuredPromptItem): StructuredAgentSessionAction | null {
    if (!valid(item)) {
      return null
    }
    const action = admit()
    if (!action) {
      return null
    }
    const generation = lifetime.current.generation
    const mutate: StructuredAgentSessionMutate = <T>(
      ...args: Parameters<StructuredAgentSessionMutate>
    ) =>
      generation === lifetime.current.generation && valid(item)
        ? action.mutate<T>(...args)
        : Promise.resolve(null)
    return { ...action, mutate }
  }
  return {
    prompts,
    respond: (item: StructuredPromptItem, response: AgentSessionPromptResponse) =>
      respondToStructuredAgentSessionPrompt({ item, response, action: guardedAction(item) }),
    cancel: (item: StructuredPromptItem) =>
      cancelStructuredAgentSessionPrompt(guardedAction(item), undefined, {
        itemId: item.itemId,
        expectedRevision: item.revision
      })
  }
}
