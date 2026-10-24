// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConversationSurfaceSnapshot } from '../../../../shared/conversation-surface-rpc'
import type { useNativeChatConversationControls } from './use-native-chat-conversation-controls'
import english from '../../i18n/locales/en.json'
import { NativeChatConversationControlsPanel } from './NativeChatConversationControlsPanel'
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, name) => String(values?.[name] ?? name))
}))
afterEach(cleanup)
const agent: ConversationSurfaceSnapshot['active'] = {
  sessionId: 'b',
  agent: 'codex',
  agentLabel: 'Codex',
  profile: { state: 'unknown' },
  authenticatedAccount: { state: 'unknown' },
  host: { id: 'local', label: 'Local' },
  workspace: { id: 'workspace', label: 'Project', kind: 'folder', wslDistro: null },
  permissions: { selected: null, applied: null, state: 'unverified' },
  startupTrust: 'unobserved',
  transport: 'first-user-turn'
}
const snapshot: ConversationSurfaceSnapshot = {
  conversation: {
    conversationId: 'c',
    revision: 2,
    contextGeneration: 1,
    activationFence: 2,
    activeSegmentId: 'a',
    pendingOperationKey: 'op',
    location: {
      executionHostId: 'local',
      workspaceId: 'workspace',
      workspaceKind: 'folder',
      wslDistro: null
    }
  },
  active: { ...agent, sessionId: 'a', agent: 'claude', agentLabel: 'Claude Code' },
  selected: agent,
  surface: null,
  operation: {
    operationKey: 'op',
    conversationId: 'c',
    targetSessionId: 'b',
    candidateSegmentId: 'candidate',
    contextGeneration: 1,
    activationFence: 2,
    nativeBindingGeneration: 1,
    version: 1,
    phase: 'quiescing',
    sourceBoundaryCount: 1,
    candidateBoundaryCount: 1
  }
}
function controls(): ReturnType<typeof useNativeChatConversationControls> {
  return {
    busy: false,
    transferRecovery: undefined,
    recoverTransfer: vi.fn(),
    readOlderIntentions: vi.fn(),
    reconcileTransferStatus: vi.fn(),
    preparation: null,
    trust: null,
    evidence: null,
    agentSwitch: {
      active: { id: 'claude', label: 'Claude Code' },
      selected: { id: 'codex', label: 'Codex' },
      choices: [],
      busy: false,
      onSelect: vi.fn()
    },
    notices: [],
    approveManifest: vi.fn(),
    approvePolicy: vi.fn(),
    advance: vi.fn(),
    cancel: vi.fn(),
    approveTrust: vi.fn(),
    readEvidence: vi.fn(),
    select: vi.fn()
  }
}
it('keeps an unknown delivery in reconciliation without allowing cancellation or new delivery', () => {
  const actions = controls()
  const rebuild = vi.fn()
  render(
    <NativeChatConversationControlsPanel
      snapshot={{
        ...snapshot,
        operation: snapshot.operation && { ...snapshot.operation, phase: 'reconciliation-required' }
      }}
      controls={actions}
      onRebuild={rebuild}
    />
  )
  expect(screen.getByText(/authenticated provider account has not been verified/)).toBeTruthy()
  expect(screen.getByText(/permission enforcement is not yet confirmed/)).toBeTruthy()
  const cancel = screen.getByRole('button', { name: 'Cancel switch' })
  expect(cancel.hasAttribute('disabled')).toBe(true)
  fireEvent.click(cancel)
  expect(actions.cancel).not.toHaveBeenCalled()
  const rebuildButton = screen.getByRole('button', { name: /Rebuild selected native session/ })
  expect(rebuildButton.hasAttribute('disabled')).toBe(true)
  fireEvent.click(rebuildButton)
  expect(rebuild).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile this switch' }))
  expect(actions.advance).toHaveBeenCalledTimes(1)
})
it('explains individual evidence gaps and critical exclusions without exposing source payload', () => {
  const actions = controls()
  actions.evidence = {
    manifestDigest: 'm',
    sourceRevision: 'r',
    targetBindingDigest: 't',
    transformationsDigest: 'x',
    omissionsDigest: 'o',
    manifestGaps: [
      {
        source: { sessionId: 'a', epoch: 'epoch', sequence: 1 },
        reason: 'excluded',
        critical: true
      }
    ],
    entries: [],
    next: null,
    complete: true
  }
  render(<NativeChatConversationControlsPanel snapshot={snapshot} controls={actions} />)
  expect(screen.getByText(/Excluded by disclosure policy/)).toBeTruthy()
  expect(screen.getByText(/Critical input/)).toBeTruthy()
  expect(screen.queryByText(/secret payload/)).toBeNull()
})
it('removes switch controls after activation instead of implying a pending target', () => {
  const { container } = render(
    <NativeChatConversationControlsPanel
      snapshot={{
        ...snapshot,
        operation: snapshot.operation && { ...snapshot.operation, phase: 'activated' }
      }}
      controls={controls()}
    />
  )
  expect(container.textContent).toBe('')
})

it('identifies authenticated transport removal separately from exact, summary or missing evidence', () => {
  const actions = controls()
  actions.evidence = {
    manifestDigest: 'm',
    sourceRevision: 'r',
    targetBindingDigest: 't',
    transformationsDigest: 'x',
    omissionsDigest: 'o',
    manifestGaps: [],
    entries: [
      {
        ordinal: 1,
        version: {
          source: { sessionId: 'b', epoch: 'epoch', sequence: 2 },
          sha256: 'a'.repeat(64)
        },
        representation: 'transport-projected',
        spans: [],
        gaps: [],
        transformedText: 'Original user trigger retained.'
      }
    ],
    next: null,
    complete: true
  }
  render(<NativeChatConversationControlsPanel snapshot={snapshot} controls={actions} />)
  const label = 'Authenticated transport wrapper removed; original user text retained'
  expect(screen.getByText(`— ${label}`)).toBeTruthy()
  expect(screen.getByText('Original user trigger retained.')).toBeTruthy()
  expect(english).toHaveProperty(
    ['components', 'native-chat', 'agentSwitch', 'representationTransportProjected'],
    label
  )
})

it('retains the read-only failed intention after cancellation with no selected candidate', () => {
  const actions = controls()
  actions.transferRecovery = {
    version: 1,
    next: null,
    intentions: [
      {
        transferId: 'transfer',
        kind: 'trigger',
        operationKey: 'op',
        targetSessionId: 'b',
        sourceSessionId: 'a',
        sourceMessageId: 'draft',
        status: 'cancelled-retained',
        actions: [],
        scope: null,
        original: {
          text: 'Keep this exact original',
          truncated: false,
          bodyBytes: 128,
          bodyDigest: 'a'.repeat(64),
          attachmentCount: 1
        }
      }
    ]
  }
  render(
    <NativeChatConversationControlsPanel
      snapshot={{ ...snapshot, selected: null, operation: null }}
      controls={actions}
    />
  )
  expect(screen.getByText('Keep this exact original')).toBeTruthy()
  expect(
    screen.getByText('Transfer cancelled. The failed intention and original are retained.')
  ).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Return held draft' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Copy original text' })).toBeTruthy()
})

it('shows explicit host-advertised recovery only, with a clearly labelled bounded preview', () => {
  const actions = controls()
  const intention = {
    transferId: 'transfer',
    kind: 'trigger' as const,
    operationKey: 'op',
    targetSessionId: 'b',
    sourceSessionId: 'a',
    sourceMessageId: 'draft',
    status: 'message-not-sent' as const,
    actions: ['return-held-draft', 'cancel-retain'] as const,
    scope: {
      operationKey: 'op',
      transferId: 'transfer',
      expectedVersion: 1,
      expectedRevision: 2,
      expectedContextGeneration: 1,
      expectedActivationFence: 2,
      expectedNativeBindingGeneration: 1,
      expectedRuntimeFence: 1,
      expectedTargetEpoch: 'epoch',
      expectedRecoveryAttempt: 0,
      expectedProofDigest: 'b'.repeat(64)
    },
    original: {
      text: 'Only a preview',
      truncated: true,
      bodyBytes: 9999,
      bodyDigest: 'a'.repeat(64),
      attachmentCount: 0
    }
  }
  actions.transferRecovery = {
    version: 1,
    next: null,
    intentions: [{ ...intention, actions: [...intention.actions] }]
  }
  render(<NativeChatConversationControlsPanel snapshot={snapshot} controls={actions} />)
  expect(screen.getByText(/Truncated original text preview/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Copy text preview only' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Return held draft' }))
  expect(actions.recoverTransfer).toHaveBeenCalledWith(
    expect.objectContaining({ transferId: 'transfer' }),
    'return-held-draft'
  )
  expect(actions.advance).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: /Retry selected target/i })).toBeNull()
})

it('unknown delivery keeps original visible without return or cancel recovery buttons', () => {
  const actions = controls()
  actions.transferRecovery = {
    version: 1,
    next: null,
    intentions: [
      {
        transferId: 'transfer',
        kind: 'trigger',
        operationKey: 'op',
        targetSessionId: 'b',
        sourceSessionId: 'a',
        sourceMessageId: 'draft',
        status: 'delivery-uncertain',
        actions: [],
        scope: null,
        original: {
          text: 'Do not resend this',
          truncated: false,
          bodyBytes: 120,
          bodyDigest: 'a'.repeat(64),
          attachmentCount: 0
        }
      }
    ]
  }
  render(
    <NativeChatConversationControlsPanel
      snapshot={{
        ...snapshot,
        operation: snapshot.operation && { ...snapshot.operation, phase: 'reconciliation-required' }
      }}
      controls={actions}
    />
  )
  expect(screen.getByText('Do not resend this')).toBeTruthy()
  expect(
    screen.getByText(
      'Delivery uncertain. Reconcile delivery; the original is read-only and will not be resent.'
    )
  ).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }))
  expect(actions.reconcileTransferStatus).toHaveBeenCalledOnce()
  expect(actions.recoverTransfer).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Reconcile this switch' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Return held draft' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Cancel transfer and keep original' })).toBeNull()
})
