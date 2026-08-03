---
name: conventions-ai
description: "Apply when building or reviewing Stella AI chat, model/provider adapters, tools, prompts, streaming, message persistence, approvals, structured output, or AI-generated follow-ups. Enforces exhaustive SDK state handling, truthful capability exposure, recoverable failures, and stream-to-reload parity."
---

# AI Conventions

AI integrations are protocol boundaries. Keep SDK evolution, provider iteration,
tool failures, persistence, and UI reconstruction from producing silent state loss.

## Read the contract first

- Fetch current documentation for the exact installed AI SDK and adapters before
  changing lifecycle or state handling. Inspect installed types and implementation
  when documentation does not define event ordering precisely.
- Trace the complete vertical path: provider events, server stream bridge, client
  stream processor, message-part types, persistence validation, reload, and UI.
  A fix at one layer is incomplete if another layer can discard the same state.

## Make SDK states exhaustive

- Never reinterpret or manually redeclare a protocol shape that can be inherited
  from upstream. Derive discriminators, states, message parts, hook surfaces, and
  event unions from the installed SDK's exported types, then lock every member with
  an exhaustive `switch` or `satisfies Record<UpstreamUnion, ...>`. An upstream
  addition, removal, or rename must fail Stella's typecheck and force an explicit
  boundary decision.
- Derive state types from the SDK or Stella's validated boundary type. Handle them
  with an exhaustive `switch` plus a `never` check, or a
  `satisfies Record<SdkState, ...>` table.
- Never use an untyped partial allowlist, truthiness check, or permissive default
  branch for SDK states. A new SDK member must fail typecheck until its behavior is
  chosen explicitly.
- Treat values crossing a process, stream, persistence, or browser boundary as
  untrusted. Reject malformed or unknown wire values deliberately; accept and
  preserve every documented state, including partial, approval, error, and terminal
  variants.
- Keep success, recoverable failure, incomplete input, and impossible internal
  invariants distinct. A valid failed tool call is turn data, not malformed chat.

## Preserve lifecycle semantics

- Do not assume one provider iteration or SDK `RUN_STARTED` / `RUN_FINISHED` pair
  equals one user-visible assistant message. Tool cycles may contain multiple model
  runs that contribute to one assistant turn.
- Keep a logical assistant message active until the whole turn is complete. Ensure
  later tool calls, user-input requests, approvals, reasoning, and structured output
  cannot appear live and then disappear after persistence or refetch.
- End a tool when its promised user-visible result exists. Do not keep an AI tool
  unresolved across a later, independent UI decision: for example, an editable
  document draft completes document creation, while saving or exporting that draft
  is a separate user action. Otherwise the next user message enters a protocol turn
  whose preceding tool call still has no result.
- Model turn ownership explicitly. Pending user-input and approval tools own the
  turn until resolved; do not show autonomous follow-ups or drain queued messages
  while the chat is submitted, streaming, awaiting input, or in error recovery.
- Treat a thread id as a protocol-ownership key. Two independently mounted chat
  runtimes must not drive the same thread; surfaces that intentionally show one
  conversation must share one runtime instance. Otherwise allocate a distinct
  thread so tool continuation, retries, and persistence have one owner.

## Advertise only executable capabilities

- Derive tool schemas and prompt capability instructions from the same executable
  registry. If a capability cannot succeed in the current context, omit both its
  tool and its prompt instructions.
- Give public, fixed catalogs exact schemas. Keep dynamic or private catalogs
  generic only when exposing their values would leak data or create stale schemas.
- Instruct the model to recover from tool errors within the same turn: correct the
  call, choose an available alternative, or continue without the tool. Escalate to a
  fatal user-visible error only when the turn itself cannot continue.
- Generate follow-up chips from the user's perspective because they are inserted
  verbatim as user messages. Suppress them for failed, incomplete, or user-owned
  turns.

## Required tests

- Add a regression test for every fixed AI bug.
- When Stella compensates for an SDK lifecycle or event-shape mismatch, add a
  canary through the real SDK runtime at that boundary. Assert the user-visible
  invariant across streamed intermediate events, not dependency-private
  implementation details, so an upgrade fails where the assumption changes.
- Iterate every SDK union member in state-policy tests. Make the test input type
  depend on the SDK union so new members cannot be omitted silently.
- For stream changes, test a multi-run tool cycle and assert the browser-visible
  message parts equal the persisted parts and the reloaded parts.
- Cover success, recoverable tool error, incomplete/streaming structured output,
  approval, pending user input, cancellation, and malformed wire input where the
  touched boundary supports them.
- Assert unavailable capabilities are absent from both the final provider tool
  request and the assembled system prompt.
- For artifact or file surfaces that spawn chat, assert the new surface has empty
  history, a thread id distinct from its origin conversation, and a stable id
  across streaming updates and rerenders.

## Review checklist

Before finishing, verify all of these:

1. Every touched SDK union is exhaustive at compile time.
2. Every external boundary validates runtime data without dropping valid states.
3. Live, persisted, and reloaded message parts have the same meaning.
4. Advertised tools are executable in the current context.
5. Recoverable failures let the model continue without UX drama.
6. Pending human interactions retain turn ownership.
7. Focused tests reproduce lifecycle ordering, not only helper behavior.
