import {
  bindRuntimeContexts,
  startRuntimeBackgroundWork
} from './structured-conversation-runtime-contexts'
import { retireAtRestCommandContext } from '../native-chat/agent-session-wire/at-rest-command-context'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { expect, it, vi } from 'vitest'
import { createConversationDeliveryFixture } from '../native-chat/conversations/conversation-delivery.fixture'
import { finalizeConversationDeliveryReceipt } from '../native-chat/conversations/conversation-delivery-receipt'
import { createStructuredConversationRuntimeBinding } from './structured-conversation-runtime-binding'

it('denies before install and after disposal while forwarding real receipt and coverage verification', async () => {
  const f = await createConversationDeliveryFixture()
  try {
    const db = f.fixture.host.db
    const binding = createStructuredConversationRuntimeBinding(f.fixture.host)
    f.bind()
    await f.journal.resolveDispatch({
      clientMessageId: 'trigger',
      fence: 1,
      state: 'accepted',
      originCorrelation: 'exact',
      providerIdentity: { provider: 'codex', threadId: 'native-thread', turnId: 'turn', ordinal: 0 }
    })
    const receipt = await finalizeConversationDeliveryReceipt(
      db,
      f.plan.planId,
      f.authority,
      f.signal
    )
    if (!receipt) {
      throw new Error('missing canonical receipt')
    }
    const read = () =>
      binding.persistence.conversationDeliveryEvidence(db, receipt.deliveryReceiptId)
    const commit = (manifestId = f.manifest.manifestId) =>
      f.fixture.host.transaction(() =>
        binding.persistence.conversationDeliveryCommit(db, manifestId, receipt.deliveryReceiptId)
      )
    expect(read()).toBeNull()
    expect(commit).toThrow('unavailable')
    const dispose = binding.install(f.fixture.host, f.authority)
    expect(read()).toEqual(receipt)
    expect(() => commit('unrelated-manifest')).toThrow()
    expect(commit).not.toThrow()
    expect(() => binding.install(f.fixture.host, f.authority)).toThrow('already installed')
    dispose()
    expect(read()).toBeNull()
    expect(commit).toThrow('unavailable')
    const replacement = binding.install(f.fixture.host, f.authority)
    dispose()
    expect(read()).toEqual(receipt)
    replacement()
    binding.close()
    expect(() => binding.install(f.fixture.host, f.authority)).toThrow('closed')
  } finally {
    await f.fixture.close()
  }
})

it('rejects installation and callbacks across database identities', async () => {
  const a = await createConversationDeliveryFixture(),
    b = await createConversationDeliveryFixture()
  try {
    const binding = createStructuredConversationRuntimeBinding(a.fixture.host)
    expect(() => binding.install(b.fixture.host, b.authority)).toThrow('database')
    binding.install(a.fixture.host, a.authority)
    expect(
      binding.persistence.conversationDeliveryEvidence(b.fixture.host.db, 'missing')
    ).toBeNull()
    expect(() =>
      binding.persistence.conversationDeliveryCommit(b.fixture.host.db, 'm', 'r')
    ).toThrow('database')
    binding.close()
    expect(
      binding.persistence.conversationDeliveryEvidence(a.fixture.host.db, 'missing')
    ).toBeNull()
  } finally {
    await a.fixture.close()
    await b.fixture.close()
  }
})

it('unwinds command subscriptions on binding failure without disposing the existing host', async () => {
  const f = await createConversationDeliveryFixture()
  try {
    const binding = createStructuredConversationRuntimeBinding(f.fixture.host)
    const disposeExisting = binding.install(f.fixture.host, f.authority)
    const dispose = vi.fn(),
      retireContext = vi.fn()
    const registrations = [
      {
        adapter: {
          atRestCommands: {
            read: () => undefined,
            onChange: () => () => undefined,
            dispose,
            retireContext
          }
        }
      }
    ]
    expect(() =>
      bindRuntimeContexts(
        registrations,
        {
          journalDatabase: f.fixture.host,
          conversationDeliveryBinding: binding
        },
        f.authority
      )
    ).toThrow('already installed')
    expect(dispose).toHaveBeenCalledOnce()
    retireAtRestCommandContext()
    expect(retireContext).not.toHaveBeenCalled()
    expect(() => binding.install(f.fixture.host, f.authority)).toThrow('already installed')
    disposeExisting()
    binding.close()
  } finally {
    await f.fixture.close()
  }
})

it('unwinds installed delivery when subsequent background startup fails', async () => {
  const f = await createConversationDeliveryFixture()
  try {
    const binding = createStructuredConversationRuntimeBinding(f.fixture.host)
    const dispose = vi.fn()
    expect(() =>
      startRuntimeBackgroundWork({
        deps: {
          stateDirectory: '/unused',
          logger: createStructuredAgentSessionLogger(),
          get nativeChatVisuals(): { isEnabled: () => boolean } {
            throw new Error('startup failed')
          }
        },
        opened: {
          journalDatabase: f.fixture.host,
          store: f.fixture.records,
          conversationDeliveryBinding: binding
        },
        registrations: [
          {
            adapter: {
              atRestCommands: { read: () => undefined, onChange: () => () => undefined, dispose }
            }
          }
        ],
        deliveryHost: f.authority,
        modelCatalog: undefined
      })
    ).toThrow('startup failed')
    expect(dispose).toHaveBeenCalledOnce()
    expect(() => binding.install(f.fixture.host, f.authority)).not.toThrow()
    binding.close()
  } finally {
    await f.fixture.close()
  }
})
