// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConversationPreparationView } from '../../../../shared/conversation-rpc'
import english from '../../i18n/locales/en.json'
import { NativeChatConversationPreview } from './NativeChatConversationPreview'
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
      fallback
    )
}))
afterEach(cleanup)
const view: ConversationPreparationView = {
  operationKey: 'op',
  conversationId: 'conversation',
  operationVersion: 2,
  contextGeneration: 1,
  phase: 'quiescing',
  activeSessionId: 'a',
  selectedSessionId: 'b',
  approvalRevision: 0,
  target: {
    sessionId: 'b',
    provider: 'codex',
    model: '',
    accountBindingDigest: 'private-digest',
    capabilityFingerprint: 'capability',
    bindingDigest: 'target',
    budget: 'unknown'
  },
  preview: null,
  status: 'recipient-choice'
}
const preview = {
  manifestDigest: 'manifest',
  targetBindingDigest: 'target',
  capabilityFingerprint: 'capability',
  transformationsDigest: 'transforms',
  omissionsDigest: 'omissions',
  policy: 'budgeted',
  completeness: 'budgeted-projection',
  sourceCount: 150,
  gapCount: null,
  gapCountComplete: false,
  inputEstimate: 234,
  estimateConfidence: 'unknown',
  consented: false
} satisfies NonNullable<ConversationPreparationView['preview']>
const props = () => ({
  view,
  busy: false,
  onPolicy: vi.fn(),
  onApprove: vi.fn(),
  onEvidence: vi.fn()
})
it('discloses unknown capacity and limited first-turn delivery without exposing binding digests', () => {
  render(<NativeChatConversationPreview {...props()} />)
  expect(screen.getByText(/Native context capacity and occupancy are unknown/)).toBeTruthy()
  expect(screen.getByText(/first user turn/)).toBeTruthy()
  expect(screen.queryByText('private-digest')).toBeNull()
})
it('requires an explicit budgeted choice and keeps fresh start a separate operation', () => {
  const input = props()
  render(<NativeChatConversationPreview {...input} />)
  fireEvent.click(screen.getByRole('button', { name: 'Review budgeted delivery' }))
  expect(input.onPolicy).toHaveBeenCalledExactlyOnceWith('budgeted')
  expect(input.onApprove).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: /Fresh/ })).toBeNull()
})
it.each(['unknown', 'observed'] as const)(
  'keeps full delivery unavailable with %s budget evidence',
  (budget) => {
    const input = props()
    const rendered = render(
      <NativeChatConversationPreview
        {...input}
        view={{ ...view, target: { ...view.target!, budget } }}
      />
    )
    const full = screen.getByRole('button', { name: 'Review full delivery' })
    expect(full.hasAttribute('disabled')).toBe(true)
    fireEvent.click(full)
    expect(input.onPolicy).not.toHaveBeenCalled()
    const guidance =
      'Verified full delivery is not available in this implementation. Review budgeted delivery instead.'
    expect(screen.getByText(guidance)).toBeTruthy()
    expect(english).toHaveProperty(
      ['components', 'native-chat', 'agentSwitch', 'fullDeliveryUnavailable'],
      guidance
    )
    rendered.rerender(<NativeChatConversationPreview {...input} busy />)
    const budgeted = screen.getByRole('button', { name: 'Review budgeted delivery' })
    expect(budgeted.hasAttribute('disabled')).toBe(true)
    fireEvent.click(budgeted)
    expect(input.onPolicy).not.toHaveBeenCalled()
  }
)
it('binds approval to the exact preview that the user saw and exposes evidence review', () => {
  const input = props()
  const frozen = { ...view, status: 'preview', preview } satisfies ConversationPreparationView
  render(<NativeChatConversationPreview {...input} view={frozen} />)
  fireEvent.click(screen.getByRole('button', { name: 'Review transformations and omissions' }))
  expect(input.onEvidence).toHaveBeenCalledExactlyOnceWith(frozen)
  fireEvent.click(screen.getByRole('button', { name: 'Approve this projection' }))
  expect(input.onApprove).toHaveBeenCalledExactlyOnceWith(frozen)
  expect(screen.getByText(/Gap count is incomplete/)).toBeTruthy()
})
it('blocks stale preview approval and duplicate submissions while a request is pending', () => {
  const input = props()
  const rendered = render(
    <NativeChatConversationPreview {...input} view={{ ...view, status: 'stale', preview }} />
  )
  expect(screen.queryByRole('button', { name: 'Approve this projection' })).toBeNull()
  rendered.rerender(
    <NativeChatConversationPreview {...input} busy view={{ ...view, status: 'preview', preview }} />
  )
  expect(
    screen.getByRole('button', { name: 'Approve this projection' }).hasAttribute('disabled')
  ).toBe(true)
})
it.each([
  [undefined, 'Workspace changes cannot be reliably observed here.'],
  ['unknown', 'Workspace changes cannot be reliably observed here.'],
  ['no-change-observed', 'No workspace change was observed during this preview.'],
  [
    'observed-change',
    'Workspace changes were observed after this preview was captured. Review refreshed context before proceeding.'
  ]
] as const)(
  'discloses %s workspace observations without promising exclusive ownership',
  (status, text) => {
    render(
      <NativeChatConversationPreview
        {...props()}
        view={{ ...view, workspaceObservation: status }}
      />
    )
    expect(screen.getByText(text)).toBeTruthy()
    expect(
      screen.getByText(/Switching agents does not lock the workspace or roll back those edits/)
    ).toBeTruthy()
  }
)
it('cannot approve a projection with an observed workspace change even before the stale flag arrives', () => {
  const input = props()
  render(
    <NativeChatConversationPreview
      {...input}
      view={{ ...view, status: 'preview', preview, workspaceObservation: 'observed-change' }}
    />
  )
  expect(screen.queryByRole('button', { name: 'Approve this projection' })).toBeNull()
  expect(input.onApprove).not.toHaveBeenCalled()
})
it.each(['delivering', 'reconciliation-required'] as const)(
  'does not recommend resending or fresh approval after possible effects in %s',
  (phase) => {
    render(
      <NativeChatConversationPreview
        {...props()}
        view={{ ...view, phase, status: 'stale', workspaceObservation: 'observed-change' }}
      />
    )
    expect(screen.getByText(/Reconcile the existing turn without resending it/)).toBeTruthy()
    expect(screen.queryByText(/Review a refreshed preview before approving delivery/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve this projection' })).toBeNull()
  }
)

it('guides an unavailable target toward an available agent and explicit model without enabling approval', () => {
  render(
    <NativeChatConversationPreview
      {...props()}
      view={{ ...view, target: null, status: 'target-unavailable' }}
    />
  )
  const guidance =
    'Select an available agent, an explicit model, and execution settings matching the native session before reviewing delivery.'
  expect(screen.getByText(new RegExp(guidance))).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Review budgeted delivery' })).toBeNull()
  expect(english).toHaveProperty(
    ['components', 'native-chat', 'agentSwitch', 'selectExplicitExecutionSettings'],
    guidance
  )
})
