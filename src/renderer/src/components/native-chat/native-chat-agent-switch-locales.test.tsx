// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider, useTranslation } from 'react-i18next'
import { afterEach, expect, it, vi } from 'vitest'
import { i18n, setRendererPluginLanguagePacks, setRendererUiLanguage } from '@/i18n/i18n'
import { UI_LANGUAGE_CHOICES } from '@/i18n/supported-languages'
import { pluginLanguageResourceId } from '../../../../shared/plugins/plugin-language-pack-artifact'
import english from '../../i18n/locales/en.json'
import type { ConversationPreparationView } from '../../../../shared/conversation-rpc'
import { NativeChatConversationPreview } from './NativeChatConversationPreview'
import { NativeChatTransferRecoveryPanel } from './NativeChatTransferRecoveryPanel'
import { NativeChatAgentSwitchPicker } from './NativeChatAgentSwitchPicker'
import { nativeChatConversationNotice } from './native-chat-conversation-notices'
import { NativeChatConversationClear } from './NativeChatConversationClear'
import { NativeChatConversationArchive } from './NativeChatConversationArchive'
import { entrySnapshot } from './native-chat-conversation-entry.test-fixture'
import type { ConversationSurfaceSnapshot } from '../../../../shared/conversation-surface-rpc'
const retentionRpc = vi.hoisted(() =>
  vi.fn<(method: string, params: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>>(
    async () => null
  )
)
vi.mock('@/runtime/conversation-reader-owner', () => ({
  captureConversationReaderOwner: () => ({
    request: retentionRpc,
    current: () => true,
    subscribe: () => () => {}
  })
}))
const retentionSnapshot: ConversationSurfaceSnapshot = {
  ...entrySnapshot,
  operation: null,
  clear: null,
  conversation: { ...entrySnapshot.conversation, pendingOperationKey: null }
}
function RetentionSurface({
  snapshot = retentionSnapshot
}: {
  snapshot?: ConversationSurfaceSnapshot
}) {
  useTranslation()
  return (
    <NativeChatConversationClear
      snapshot={snapshot}
      target={{ kind: 'local' }}
      onRefresh={async () => {}}
    />
  )
}

function Surface() {
  useTranslation()
  return (
    <>
      <NativeChatAgentSwitchPicker
        active={{ id: 'claude', label: 'Claude Code' }}
        selected={{ id: 'codex', label: 'Codex' }}
        choices={[
          { id: 'claude', label: 'Claude Code' },
          { id: 'codex', label: 'Codex' }
        ]}
        busy={false}
        onSelect={vi.fn()}
      />
      <p>{nativeChatConversationNotice(null, { reason: 'unverified-delivery' })?.text}</p>
    </>
  )
}
afterEach(async () => {
  cleanup()
  retentionRpc.mockReset().mockResolvedValue(null)
  setRendererPluginLanguagePacks([])
  await setRendererUiLanguage('en')
})
it('extracts nested English keys for selector and delivery safety copy', () => {
  expect(english).toHaveProperty(
    ['components', 'native-chat', 'agentSwitch', 'label'],
    'Agent {{agent}}'
  )
  expect(english).toHaveProperty(['components', 'native-chat', 'agentSwitch', 'unverifiedDelivery'])
})
it.each(
  UI_LANGUAGE_CHOICES.filter((choice) => choice.value !== 'system').map((choice) => choice.value)
)('renders named agent interpolation and permitted fallback in %s', async (language) => {
  await setRendererUiLanguage(language)
  const { container } = render(
    <I18nextProvider i18n={i18n}>
      <Surface />
    </I18nextProvider>
  )
  expect(screen.getByRole('button', { name: /Claude Code/ })).toBeTruthy()
  expect(container.textContent).toContain('Codex')
  expect(container.textContent).not.toContain('{{agent}}')
  expect(container.textContent).not.toContain('components.native-chat.agentSwitch')
  expect(container.textContent).toContain('Native acceptance is unverified')
})
it('updates the rendered picker for a plugin language and restores English fallback on removal', async () => {
  await setRendererUiLanguage('en')
  render(
    <I18nextProvider i18n={i18n}>
      <Surface />
    </I18nextProvider>
  )
  const id = 'plugin:orca-test.switch/zz-ZZ' as const
  await act(async () => {
    setRendererPluginLanguagePacks([
      {
        id,
        resourceLanguage: pluginLanguageResourceId(id),
        pluginKey: 'orca-test.switch',
        locale: 'zz-ZZ',
        catalog: {
          components: { 'native-chat': { agentSwitch: { label: 'Test harness {{agent}}' } } }
        }
      }
    ])
    await setRendererUiLanguage(id)
  })
  expect(screen.getByRole('button', { name: 'Test harness Claude Code' })).toBeTruthy()
  expect(screen.getByText(/Native acceptance is unverified/)).toBeTruthy()
  await act(async () => {
    setRendererPluginLanguagePacks([])
    await setRendererUiLanguage(id)
  })
  expect(screen.getByRole('button', { name: 'Agent Claude Code' })).toBeTruthy()
})

const frozenPreview: ConversationPreparationView = {
  operationKey: 'preview',
  conversationId: 'conversation',
  operationVersion: 1,
  contextGeneration: 1,
  phase: 'prepared',
  activeSessionId: 'claude',
  selectedSessionId: 'codex',
  approvalRevision: 1,
  status: 'preview',
  target: {
    sessionId: 'codex',
    provider: 'codex',
    model: 'unknown',
    accountBindingDigest: 'private-account-binding',
    capabilityFingerprint: 'cap',
    bindingDigest: 'target',
    budget: 'unknown'
  },
  preview: {
    manifestDigest: 'manifest',
    targetBindingDigest: 'target',
    capabilityFingerprint: 'cap',
    transformationsDigest: 'transforms',
    omissionsDigest: 'omissions',
    policy: 'budgeted',
    completeness: 'budgeted-projection',
    sourceCount: 3,
    gapCount: 1,
    gapCountComplete: true,
    inputEstimate: 123,
    estimateConfidence: 'unknown',
    consented: false
  }
}
it.each(
  UI_LANGUAGE_CHOICES.filter((choice) => choice.value !== 'system').map((choice) => choice.value)
)(
  'renders consent preview counts and unknown-budget refusal in %s without exposing binding metadata',
  async (language) => {
    await setRendererUiLanguage(language)
    const { container, rerender } = render(
      <NativeChatConversationPreview
        view={frozenPreview}
        busy={false}
        onPolicy={vi.fn()}
        onApprove={vi.fn()}
        onEvidence={vi.fn()}
      />
    )
    expect(container.textContent).toContain('Source records: 3')
    expect(container.textContent).toContain('Known gaps: 1')
    expect(container.textContent).toContain('Native context capacity and occupancy are unknown')
    expect(container.textContent).toContain('Workspace changes cannot be reliably observed here.')
    expect(container.textContent).toContain('Switching agents does not lock the workspace')
    expect(container.textContent).not.toMatch(
      /\{\{|components\.native-chat|private-account-binding/
    )
    expect(screen.getByRole('button', { name: 'Approve this projection' })).toBeTruthy()
    rerender(
      <NativeChatConversationPreview
        view={{ ...frozenPreview, status: 'recipient-choice', preview: null }}
        busy={false}
        onPolicy={vi.fn()}
        onApprove={vi.fn()}
        onEvidence={vi.fn()}
      />
    )
    expect(container.textContent).toContain(
      'Verified full delivery is not available in this implementation. Review budgeted delivery instead.'
    )
    expect(
      screen.getByRole('button', { name: 'Review full delivery' }).hasAttribute('disabled')
    ).toBe(true)
    expect(container.textContent).not.toContain('components.native-chat.agentSwitch')
    rerender(
      <NativeChatConversationPreview
        view={{ ...frozenPreview, status: 'stale' }}
        busy={false}
        onPolicy={vi.fn()}
        onApprove={vi.fn()}
        onEvidence={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: 'Approve this projection' })).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('source or target changed')
    rerender(
      <NativeChatConversationPreview
        view={{ ...frozenPreview, workspaceObservation: 'observed-change' }}
        busy={false}
        onPolicy={vi.fn()}
        onApprove={vi.fn()}
        onEvidence={vi.fn()}
      />
    )
    expect(container.textContent).toContain('Workspace changes were observed after this preview')
    expect(screen.queryByRole('button', { name: 'Approve this projection' })).toBeNull()
  }
)

it.each(
  UI_LANGUAGE_CHOICES.filter((choice) => choice.value !== 'system').map((choice) => choice.value)
)(
  'renders clear confirmation and reconciliation safety copy in %s without issuing a mutation',
  async (language) => {
    await setRendererUiLanguage(language)
    const { container, rerender } = render(
      <I18nextProvider i18n={i18n}>
        <RetentionSurface />
      </I18nextProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Clear context' }))
    expect(screen.getByText(/Old native sessions will not resume/)).toBeTruthy()
    expect(screen.getByText(/does not erase provider data/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Clear all agents and keep archive' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep current context' }))
    expect(retentionRpc).not.toHaveBeenCalled()
    const clear = {
      operationKey: 'clear-op',
      conversationId: 'c',
      version: 1,
      contextGeneration: 1,
      activationFence: 2,
      phase: 'quiescing' as const,
      preserveArchive: true as const
    }
    rerender(
      <I18nextProvider i18n={i18n}>
        <RetentionSurface snapshot={{ ...retentionSnapshot, clear }} />
      </I18nextProvider>
    )
    expect(screen.getByText(/Context clear is pending/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue context clear' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel context clear' })).toBeTruthy()
    rerender(
      <I18nextProvider i18n={i18n}>
        <RetentionSurface
          snapshot={{ ...retentionSnapshot, clear: { ...clear, phase: 'reconciliation-required' } }}
        />
      </I18nextProvider>
    )
    expect(screen.getByText(/Native shutdown is unconfirmed/)).toBeTruthy()
    expect(screen.getByText(/does not undo native side effects/)).toBeTruthy()
    expect(container.textContent).not.toMatch(/\{\{|components\.native-chat/)
    expect(retentionRpc).not.toHaveBeenCalled()
  }
)
it.each(
  UI_LANGUAGE_CHOICES.filter((choice) => choice.value !== 'system').map((choice) => choice.value)
)(
  'renders archive confirmation, cleanup and completion in %s with explicit provider-erasure limits',
  async (language) => {
    await setRendererUiLanguage(language)
    const snapshot = {
      ...retentionSnapshot,
      conversation: { ...retentionSnapshot.conversation, contextGeneration: 2 }
    }
    const props = {
      snapshot,
      busy: false,
      request: retentionRpc,
      run: async (action: () => Promise<void>) => action()
    }
    const { container, rerender } = render(<NativeChatConversationArchive {...props} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete archive' })).toBeTruthy())
    expect(
      screen.getByRole('spinbutton', { name: 'Archived context version' }).getAttribute('value')
    ).toBe('1')
    expect(screen.getByText(/Provider data is not erased/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete archive' }))
    expect(screen.getByRole('button', { name: 'Delete this archived context' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep archive' }))
    expect(retentionRpc.mock.calls.map(([method]) => method)).toEqual([
      'conversation.archiveStatus'
    ])
    retentionRpc.mockResolvedValue({ operationKey: 'delete-op', phase: 'cleanup' })
    rerender(<NativeChatConversationArchive key="cleanup" {...props} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Continue archive cleanup' })).toBeTruthy()
    )
    expect(screen.getByText(/retained payload cleanup is pending/)).toBeTruthy()
    retentionRpc.mockResolvedValue({ operationKey: 'delete-op', phase: 'complete' })
    rerender(<NativeChatConversationArchive key="complete" {...props} />)
    await waitFor(() =>
      expect(screen.getByText('Archive removed. Shared evidence may remain.')).toBeTruthy()
    )
    expect(screen.queryByRole('button', { name: 'Continue archive cleanup' })).toBeNull()
    expect(container.textContent).not.toMatch(/\{\{|components\.native-chat/)
    expect(
      retentionRpc.mock.calls.every(([method]) => method === 'conversation.archiveStatus')
    ).toBe(true)
  }
)

it('keeps open retention confirmation through plugin language changes with sparse safety fallback', async () => {
  const snapshot = {
    ...retentionSnapshot,
    conversation: { ...retentionSnapshot.conversation, contextGeneration: 2 }
  }
  render(
    <I18nextProvider i18n={i18n}>
      <RetentionSurface snapshot={snapshot} />
    </I18nextProvider>
  )
  await waitFor(() => expect(screen.getByRole('button', { name: 'Delete archive' })).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Clear context' }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete archive' }))
  const id = 'plugin:orca-test.retention/zz-ZZ' as const
  await act(async () => {
    setRendererPluginLanguagePacks([
      {
        id,
        resourceLanguage: pluginLanguageResourceId(id),
        pluginKey: 'orca-test.retention',
        locale: 'zz-ZZ',
        catalog: {
          components: {
            'native-chat': {
              agentSwitch: {
                confirmClear: 'Plugin confirm clear',
                confirmArchiveDelete: 'Plugin confirm archive deletion'
              }
            }
          }
        }
      }
    ])
    await setRendererUiLanguage(id)
  })
  expect(screen.getByRole('button', { name: 'Plugin confirm clear' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Plugin confirm archive deletion' })).toBeTruthy()
  expect(screen.getByText(/Old native sessions will not resume/)).toBeTruthy()
  expect(screen.getByText(/Provider data is not erased/)).toBeTruthy()
  await act(async () => {
    setRendererPluginLanguagePacks([])
    await setRendererUiLanguage(id)
  })
  expect(screen.getByRole('button', { name: 'Clear all agents and keep archive' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Delete this archived context' })).toBeTruthy()
  expect(retentionRpc.mock.calls.every(([method]) => method === 'conversation.archiveStatus')).toBe(
    true
  )
})

it.each(
  UI_LANGUAGE_CHOICES.filter((choice) => choice.value !== 'system').map((choice) => choice.value)
)('retains recovery safety copy through inline fallback in %s', async (language) => {
  await setRendererUiLanguage(language)
  const { container } = render(
    <NativeChatTransferRecoveryPanel
      controls={{
        busy: false,
        recoverTransfer: vi.fn(),
        readOlderIntentions: vi.fn(),
        reconcileTransferStatus: vi.fn(),
        transferRecovery: {
          version: 1,
          next: null,
          intentions: [
            {
              transferId: 'transfer',
              kind: 'trigger',
              operationKey: 'operation',
              targetSessionId: 'target',
              sourceSessionId: 'source',
              sourceMessageId: 'draft',
              status: 'cancelled-retained',
              actions: [],
              scope: null,
              original: null
            }
          ]
        }
      }}
    />
  )
  expect(container.textContent).toContain(
    'Transfer cancelled. The failed intention and original are retained.'
  )
  expect(container.textContent).toContain('Target: target · Switch: operation')
  expect(container.textContent).toContain('The retained original cannot currently be verified.')
  expect(container.textContent).not.toMatch(/\{\{|components\.native-chat/)
})
