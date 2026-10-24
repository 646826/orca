# Native conversation failed-transfer recovery

This is a bounded recovery path for journal-owned transfers, not a native retry feature. The surrounding native-conversation feature remains experimental; these storage, host and renderer tests do not establish an account-backed or rendered end-to-end transition.

## User choices

An exact durable **no user-turn write** proof may offer:

- **Return held draft**: restore one exact source draft, including its body, options, attachment references, original order and queue timestamp. The draft is held with `send_failed`; it does not automatically Send, Resume, advance a switch or start a provider.
- **Cancel transfer and keep original**: do not restore a queue card, but keep the original and failed intention readable.

Both choices retire the old target submission and cancel its exclusive transfer reservation in the same host transaction. A failed triggering transfer also cancels its pending switch. A failed queued continuation cancels only that transfer: the already activated parent intent and active conversation remain unchanged apart from the conversation revision.

**Direct retry of the old target is unsupported.** To try again, explicitly return the draft, then make a separate new send or switch request with current preparation and consent. Old immutable payloads, recipient settings and native identities are never silently reused as new authorization. A pre-write refusal does not imply provider settings remained unchanged.

Unknown delivery, contradictory acceptance, missing/corrupt proof or changed context/native identity never enables either recovery action. The original remains read-only. A pending switch retains its existing Reconcile control. **Refresh status** on retained intentions rereads bounded durable status only; it does not perform native reconciliation, send or retry.

## Atomic authority and restart

Recovery uses both journal lanes and one shared record-store draft on the same database. It rechecks the exact immutable proof and pinned original, current operation/version, conversation revision/context/activation, target native generation and current runtime fence/epoch. The server captures the source fence/epoch inside the compound operation and checks them again before committing. Attachment claims and bytes must still verify.

Accepted target evidence wins over an older refusal. The target is retired with an exact historical submission-origin binding; a missing origin rolls the whole transaction back. The immutable recovery receipt and original remain readable after the pending operation clears. Repeating the identical authenticated request returns its committed receipt without restoring twice; a conflicting request refuses.

Ordinary restart retains historical evidence, but persisted `live` is not current ownership. Recovery is unavailable until standard lease reconciliation and target native reacquisition establish a current proven-live owner with the same record birth, account and semantic native handle. The source may be positively reconciled live or released, but not unreconciled/unknown/transferring. A fresh request uses current fences, not the proof's historical runtime fence. Clear, changed native generation/account or missing historical continuity stays read-only. No provider is started by the recovery action itself.

## Read and wire bounds

- Retained intentions are ordered and paged, eight per response, with a conversation-scoped cursor; they are not an unbounded history array.
- Original body/options are checked against the 1 MiB server evidence bound before parsing. Oversize or unverifiable evidence remains retained but recovery is unavailable.
- Controls carry at most 4,096 text characters per original, an explicit truncation label, complete original-body byte count/SHA-256 and attachment count. They never carry the full structured original as recovery authority.
- Copy identifies either original **text** or truncated **text preview only**. It does not claim to copy the complete structured body or attachments.
- Mutation accepts only the server-issued compare-and-swap scope and action, never a client-supplied original/preview body.

`agent-session.conversations.transfer-recovery.v1` separately negotiates the view and RPCs. Mutation additionally requires the existing full `agent-session.conversations.v2` capability and ordinary authenticated ownership/scope checks. Mobile and read-only clients cannot mutate; read-only projections advertise no recovery actions. Old v2 readers receive the unchanged snapshot shape without the new field. A new renderer receiving an old host's snapshot hides recovery instead of attempting a fallback RPC.

## Evidence

Focused coverage lives in `conversation-transfer-recovery.test.ts`, `conversation-transfer-recovery-methods.test.ts`, `NativeChatConversationControlsPanel.test.tsx` and `use-native-chat-conversation-controls.test.tsx`. It includes real host/journal pre-write rejection, held restoration/replay/races, late acceptance, missing proof/origin, bounded preview with attachments, restart reconciliation/reacquisition, fresh preparation after return, authenticated RPC publication failure/replay, paging and mixed-version behavior. The real-adapter `conversation-continuation-recovery.test.ts` suite covers held return/cancel without changing the activated parent or accepted parent receipt, subsequent drain without resend, unknown written transport failure and late acceptance. See the [verification matrix](native-conversation-switching-verification.md) for the overall feature's remaining gates.
