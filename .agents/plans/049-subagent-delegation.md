# Plan: Subagent Delegation (`spawn_subagents` tool)

Date: 2026-07-07

## Goal

Let the chat orchestrator (a capable model) delegate well-scoped subtasks to
cheap subagents that run their own bounded tool loop and return a result. The
orchestrator fans out and coordinates; the expensive model never pays for the
subagents' intermediate tokens. Built as a chat tool so results land in the
existing flat `parts[]` transcript.

## Decisions (locked)

- **Batch `spawn_subagents([...])`.** One call fans out an explicit array of
  subtasks and returns an array of results. Per-subtask shape:
  `{ task, context?, expectedOutput?, model? }`.
- **Model per subagent: `role: "fast"` by default, or an exact model id.** When
  `model` is set it resolves via `getTanStackTextModelById` (validated against
  the org's available catalog / BYOK config, so a subagent cannot pick a model
  the org isn't entitled to); otherwise `role: "fast"`. Both honor BYOK +
  mock-AI through the shared resolver.
- **Subagents can perform writes under a single upfront delegation grant**
  (unless the user is in "yolo" / auto-approve mode): the user approves the
  `spawn_subagents` call once, then every subagent runs its scoped writes
  under that grant with no further per-write prompt. See the Approval
  Architecture section — **locked as Option A**.
- **Metering: new `"subagent"` usage action type.** Clean billing separation of
  delegated spend from the parent `chat` turn.
- **Build Phase 1 + Phase 2 together**: the tool + nested loop, plus a
  dedicated subagent tool-call card. `metadata.agent` identity is deferred
  (see Scope below).

## Design Decisions (settled)

- **A subagent's *result* is a tool call.** `spawn_subagents` returns its
  results as a normal `tool-call` + `tool-result` pair in the existing
  transcript. No separate `run → steps → agent` table.
- **Cheap tier = existing `role: "fast"`.** No new model role.
- **Nested `chat()` isolates request-scoped state.** The subagent loop builds
  its own `AbortController` (child of the tool handler's `context.abortSignal`),
  its own id-mapper / `StreamProcessor` (subagent stream consumed inside the
  handler, never yielded into the parent SSE), its own analytics middleware with
  `usageMetering` populated, and never reuses the parent's `connection: "close"`
  MCP client.
- **Recursion is depth-capped via the `chat()` `context` channel.** Pass
  `context: { delegationDepth }`; at the cap (v1: depth 1) the subagent toolset
  omits `spawn_subagents`, making deeper nesting structurally impossible.
- **Shared ref registry + same `toolWorkspaceIds`.** Refs the subagent emits
  resolve in the parent transcript; no tenant UUID reaches either model;
  workspace scope is never widened.

## Approval Architecture — Option A (LOCKED)

Requirement: a subagent that hits an approval-gated tool must not silently
proceed or hang. The existing approval flow ends the turn on an
`approval-requested` part and resumes on the next request; a subagent runs
*inside* the parent's tool handler, so per-write approval can't reach the client
without durable/resumable runs.

**Locked: Option A — Delegation-grant.** `spawn_subagents` is `needsApproval`
(policy kind `mutation`): the user approves the delegation up front, then each
subagent runs its scoped writes under that grant with no further per-write
prompt. No new server-side "yolo" concept is needed — the existing client-side
**always-allow / allow-in-conversation grants** (session/localStorage,
`tool-approval-card.tsx`) already auto-approve a granted tool, so always-allowing
`spawn_subagents` *is* the yolo bypass. Fits the synchronous-tool model, no
durable-run infra.

**Hard correctness rule:** the subagent's own tool map must be built with
`needsApproval` **stripped** (approval already happened at the parent
`spawn_subagents` call, and a nested loop has no client to answer a pause) and
with client-executed tools (`create-document`, `apply-active-docx-edits`,
`ask-user`) **excluded** — either would hang the subagent loop. Build the
subagent toolset by re-running the assembly with `hasActiveDocxEditClient:
false` + at-cap depth, then re-applying every tool as non-approval (internal).

**Fast-follow (Option B, separate sub-plan): per-write bubbling** — persist each
subagent's in-progress run, end+resume the parent turn per approval, per-agent
approval queue UI. Out of scope here.

## Scope

**In scope (this pass — assumes Option A):**

- `runSubagent` helper: wraps raw `chat()` with a scoped tool map,
  `maxIterations`, isolated abort/stream/metering, model resolution
  (`role:fast` | exact id), returns final text (+ optional structured summary).
- `spawn_subagents` server tool + its scoped toolset projection.
- Delegation-grant approval: the tool is `needsApproval` when its subagents may
  write; auto-approved under yolo.
- `subagent` usage action type + metering wired through `runSubagent`.
- Registration in `getChatTools`, tool-policy classification, brief system-prompt
  section.
- Dedicated `spawn_subagents` tool-call card (task list + per-subagent model
  badge + results/errors).
- **`metadata.agent` identity: deferred to Phase 3.** In v1 subagents return text
  through the tool result and never persist their own messages, so an
  `agent?: { id; model; role }` field would have no writer (speculative unused
  field). It gains a real writer only once subagent transcripts are persisted
  (the Option B / durable-run fast-follow), so it lands there.

**Out of scope (until Option B is chosen):**

- Per-write approval bubbling and durable/resumable subagent runs.
- Sub-subagents (depth > 1).
- Live subagent progress streaming (`emitCustomEvent`) — return-only for now.
- Cross-thread / background subagents.

## Implementation

- `apps/api/src/lib/tanstack-ai-agent.ts` (new) — `runSubagent`: `chat({ tools,
  agentLoopStrategy: maxIterations(n), abortController, middleware: [analytics],
  modelOptions, context })`, consume stream with a local `StreamProcessor`,
  return the reconstructed final message. Reuses `resolveTanStackTextModel`,
  `getTanStackTextModelById`, `mergeGenerationOptions`, `systemPromptsPatch`,
  `abortControllerFromSignal` from `tanstack-ai-generate.ts` /
  `tanstack-ai-models.ts`.
- `apps/api/src/handlers/chat/tools/spawn-subagents-tool.ts` (new) — the batch
  tool: validates each subtask, resolves per-subagent model, builds the subagent
  tool map, runs subagents concurrently via `runSubagent`, returns the results
  array. Reads/sets `context.delegationDepth`.
- `apps/api/src/handlers/chat/tools/subagent-tools.ts` (new) —
  `buildSubagentTools`: the server-executable projection (code-mode reads,
  workspace/org/skill/history reads, optional paid lookups, writes under the
  delegation grant), `spawn_subagents` dropped at the depth cap; client-executed
  tools (`create-document`, `apply-active-docx-edits`, `ask-user`) always
  excluded (no client round-trip in a server handler).
- `apps/api/src/handlers/chat/tools/chat-tools.ts` — register `spawn_subagents`;
  extend `GetChatToolsProps` with delegation deps + `yoloMode`.
- `tool-policy.ts` / `BUILT_IN_CHAT_TOOL_POLICY_KINDS` — classify
  `spawn_subagents` (mutation when it may write / internal under grant model;
  finalize with the approval decision).
- `stream-chat.ts` — pass `context: { delegationDepth: 0 }` into the top-level
  `chat()` call.
- `apps/api/src/lib/usage/*` — add the `subagent` action type + its unit/credit
  mapping.
- Frontend — `apps/web/src/components/chat/spawn-subagents-card.tsx`, a
  dedicated `spawn_subagents` tool-call card (task list + per-subagent model
  badge + results/errors), driven entirely by the tool's own input/output —
  no `metadata.agent` dependency.
- System prompt — short delegation section, gated on tool registration.
- **Not built this pass:** `ChatMessageMetadata.agent` and any
  `metadata.agent` part predicates — deferred with the rest of Option B (see
  Scope above); subagents have no writer for that field yet.

**DB schema changes:** none required for the transcript. `metadata.agent` is
additive JSONB. The `subagent` usage action type touches the usage enum/config,
not necessarily a table migration (confirm against the usage schema).

## Test Cases

- Nested `chat()` returns final text; a single flat assistant message with a
  `spawn_subagents` tool-call/tool-result pair persists (no parent corruption).
- Batch fan-out: N subagents run concurrently; results map back in order.
- Model selection: `model` id resolves and is rejected when outside the org's
  entitled catalog; absent `model` uses `role:fast`.
- Depth guard: at the cap the subagent toolset omits `spawn_subagents`.
- Client-executed tools absent from the subagent toolset (no hang).
- Delegation-grant approval: non-yolo write-capable batch is `needsApproval`;
  yolo auto-approves; the grant does not leak to the next turn.
- Metering: subagent tokens recorded under `subagent` action type with the right
  model/role/org/workspace; parent turn unaffected.
- Abort propagation: aborting the parent aborts in-flight subagents.
- BYOK + `USE_MOCK_AI` both resolve for subagents.
- Shared ref registry: a subagent-emitted ref resolves in the parent transcript.

## Open Questions

- **Approval Architecture: Option A vs B** (above) — blocks the tool's approval
  wiring and whether durable-run infra is in scope now.
- **Paid lookups inside subagents**: allow web-search / registry lookups (spend)
  or restrict subagents to internal reads + writes-under-grant in v1?
- **Yolo mode source**: reuse an existing per-user/thread auto-approve setting,
  or introduce one? (Confirm where "yolo" lives today.)
