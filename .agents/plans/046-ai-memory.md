# Plan: AI Memory

Date: 2026-06-13

## Goal

Give Stella's AI assistant a persistent, tenant-scoped memory: typed facts and
preferences it can save and recall across sessions, scoped to the firm, the
lawyer, and the matter. Memory is transparent and governed — visible, editable,
audited, archive-only — because in a legal product it is a compliance surface,
not just a UX nicety.

## Design Decisions

- **Memory scope = existing tenancy scope.** Three scopes — `organization`
  (firm), `user` (lawyer), `workspace` (matter) — mirror the primitives RLS
  already enforces. No new hierarchy; the ethical wall between matters falls out
  of reusing `app.workspace_ids` scoping. Matter memory **never** crosses
  matters.
- **Read precedence: matter → user → firm.** More specific wins. A matter that
  says "cite ČSN 690" overrides the lawyer's OSCOLA default, which overrides the
  firm default. Blocks are injected (and labelled) in that order so the model
  resolves conflicts predictably.
- **Memory is untrusted free text.** It is injected into the chat prompt's
  `untrustedSuffix` (the anonymized boundary path), **never** the `safePrompt` /
  `cacheStablePrefix` (which is sent verbatim, no anonymization) and **not** via
  the existing `userContext` seam (which feeds the _safe_ half). Memory may carry
  client names / PII / privileged content, so it must cross the anonymizer like
  any other user-supplied context. The prompt-cache cost is moot — memory changes
  over time, so it was never cache-stable anyway. See `chat-prompt.ts:105-128`.
- **No matter-data side channel (ethical wall).** Two defenses, because
  user/firm memory is injected across all of a lawyer's chats:
  1. **Kind is restricted by scope.** Matter-specific kinds
     (`fact | decision | relationship`) are allowed **only** at `workspace`
     scope. `user` and `organization` scope are limited to matter-agnostic kinds
     (`preference | instruction`). Enforced by CHECK + Valibot.
  2. **Provenance gating.** Every memory carries `sourceDataWorkspaceIds`
     (mirroring `chat_threads.data_workspace_ids`), and RLS requires the
     session's accessible workspaces to be a superset (`<@`) — so a memory
     derived from matter A's content can never surface once the lawyer loses
     access to matter A, even at user scope. Mirrors `chatThreadDataScopeCheck`
     in `rls.ts:62`.
     The extractor sets `sourceDataWorkspaceIds` from the source thread and **never**
     promotes matter-specific facts into user/firm scope.
- **Firm memory write-gating is a separate route, not a dynamic permission.**
  `statements` in `@stll/permissions` are static and checked _before_ the handler
  sees the body, so "admin only when `scope=organization`" cannot live on one
  `POST /memories`. Firm-scope writes get their own handler/route
  (`POST /organization/memories`) gated by a dedicated `firmMemory`
  statement (`create`/`update`, mapped to admin + owner) — never the broader
  `organizationSettings: ["update"]`, which grants unrelated settings access.
  User/matter writes stay on the main endpoint. This is the only
  write-path asymmetry across scopes.
- **Suggest-first learning.** Only explicit user/tool actions commit. Anything
  the AI infers becomes a `status: "suggested"` memory the lawyer accepts
  (→ `active`) or dismisses (→ `archived`). Nothing is written silently — data
  minimization and auditability over convenience.
- **Background extraction is org opt-in, default off.** The extractor spends on
  the organization's own AI provider key with no user in the loop, so
  `organization_settings.memory_extraction_enabled` (admin toggle in AI
  settings) must be switched on before any org's compactions are mined. The
  extractor filters orgs in the compaction query itself. Cost attribution
  stays explicit; the `remember` tool and manual creation work regardless.
- **Own Postgres/Drizzle, not Anthropic Memory Stores.** No lock-in;
  self-hosting stays first-class; data residency stays ours.
- **No embeddings in v1.** Deterministic scoped fetch (active + pinned + recent,
  bounded, token-budgeted) is enough at per-matter memory volumes. Postgres FTS
  (`memorySearchDocuments` tsvector, reusing the `chatMessageSearchDocuments`
  pattern) is the v2 ranking step; pgvector is deferred, possibly indefinitely.
- **Scope/id integrity is structural, not runtime.** A CHECK constraint makes
  illegal scope/id combinations impossible to persist (branded-safety over
  manual discipline).
- **Archive-only during the tenant lifecycle** (the curator invariant):
  direct deletion is denied and lifecycle uses
  `active → stale@30d → archive@90d`, pinned bypasses, `supersededById` for
  dedup. Reversible by construction. Explicit exception: deleting the parent
  organization/user/workspace cascades and physically removes memory rows —
  tenant offboarding must remove data (data minimization); the invariant
  governs the curator's lifecycle within a living tenant only.
- **Reuse, don't rebuild:** prompt-injection seam in `chat-prompt.ts`; extraction
  source in `chatThreadCompactions.summaryMarkdown` + thread recaps; background
  runner in `schedulerJobs` / `jobs.ts`; the existing `"fast"` model role on the
  **batch** service tier for background work (no new role); `createAuditRecorder`
  for the audit trail; `Page<T>` cursor pagination for lists.

## Scope

**In scope (v1):**

- `aiMemories` table + migration + RLS (all three scopes).
- Explicit write: a `remember` chat tool + `POST` endpoints.
- Read/inject into the chat system prompt with scope precedence.
- Manage surface: list (`Page<T>`), pin/edit/archive (no delete), provenance.
- Suggest-first extractor + curator background jobs.

**Out of scope (for now):**

- Embeddings / pgvector semantic recall.
- A bespoke memory version-history table (the audit log covers the trail; add
  history later only if diffs prove necessary).
- Cross-tenant or global memory (never).
- Anon / pre-signup durable memory (no user/workspace → session-only; memory
  resolver tolerates their absence and returns nothing).

## Implementation

### Phase 0 — Schema + migration + RLS

- `apps/api/src/db/schema.ts` — new `aiMemories` table:
  - `id` uuid pk; `organizationId` text → `organization` (cascade on explicit
    parent erasure; direct memory deletion remains denied).
  - `scope` enum `organization | user | workspace`.
  - `userId` text → `user` (cascade, set iff scope=user);
    `workspaceId` uuid → `workspaces` (cascade, set iff scope=workspace).
  - `kind` enum `preference | fact | decision | instruction | relationship`.
  - `content` text; `language` text.
  - `sourceDataWorkspaceIds` `safeWorkspaceId().array().notNull().default([])` —
    workspaces whose content this memory was derived from; gates RLS reads
    (mirrors `chat_threads.data_workspace_ids`).
  - `status` enum `suggested | active | stale | archived` (default `active`);
    `pinned` bool.
  - `source` enum `user | tool | extracted`; `sourceMessageId` uuid →
    `chatMessages` (set null); `confidence` real (null for user/tool).
  - `createdBy` text → `user`; `supersededById` uuid self-FK (set null).
  - `createdAt`/`updatedAt`/`lastUsedAt`/`archivedAt`.
  - **CHECK** `ai_memories_scope_ids` — mutually exclusive ids _and_ kind-by-scope
    in one constraint (valid SQL, `IS NULL` / `IS NOT NULL`):
    ```sql
    (scope = 'user'
       AND user_id IS NOT NULL AND workspace_id IS NULL
       AND kind IN ('preference','instruction'))
    OR (scope = 'organization'
       AND user_id IS NULL AND workspace_id IS NULL
       AND kind IN ('preference','instruction'))
    OR (scope = 'workspace'
       AND workspace_id IS NOT NULL AND user_id IS NULL)
    ```
  - **Tenant integrity for `workspaceId`:** a single-row CHECK can't verify the
    workspace belongs to the org. Add a composite FK
    `(workspace_id, organization_id) → workspaces(id, organization_id)` (needs a
    unique index on `workspaces(id, organization_id)`), or a trigger. RLS already
    scopes by org, so this is defense-in-depth.
  - Indexes: `(userId, status)`, `(workspaceId, status)`,
    `(organizationId, scope, status)`.
  - RLS (mirror `chatThreads`, see `apps/api/src/db/rls.ts`): org match AND
    (`scope<>'user'` OR `user_id = app.user_id`) AND (`scope<>'workspace'` OR
    `workspace_id = ANY(app.workspace_ids)`) AND a **data-scope subset check**
    (`cardinality(source_data_workspace_ids) = 0 OR source_data_workspace_ids <@
    app.workspace_ids`), reusing the `chatThreadDataScopeCheck` shape. Separate
    insert/update policies; no delete policy (archive-only).
- Migration: hand-author a timestamped dir under `apps/api/drizzle/`; apply via
  `bun --filter @stll/api db:migrate` (root `package.json` only exposes
  `db:push`; `db:migrate` lives in `apps/api/package.json`). **Never**
  `drizzle-kit generate`.

### Phase 1 — Explicit write

- `apps/api/src/handlers/chat/tools/remember-tool.ts` — a `remember` chat tool
  (sibling to `chat-history-tools.ts` etc.); register in
  `apps/api/src/handlers/chat/tools/chat-tools.ts`, gate in `tool-policy.ts`.
  Tool writes user/matter memory; it cannot write firm memory (firm is
  governance-gated, below).
- `apps/api/src/handlers/memories/create.ts` — user + matter writes, via
  **`createSafeRootHandler`** (root-scoped: the endpoint accepts an optional
  `workspaceId`, so it is not workspace-pathed and must not use the
  workspace-scoped `createSafeHandler`). Valibot `v.strictObject` body (`scope ∈
  {user, workspace}`, `kind`, `content`, optional `workspaceId`, `pinned`). When
  `scope=workspace`, validate `workspaceId` explicitly against
  `ctx.accessibleWorkspaces` / `activeWorkspaceIds` (the same check root handlers
  use elsewhere). Ownership IDs from server context: `organizationId` from
  `session.activeOrganizationId`, `userId` from `session`, never from the body.
- `apps/api/src/handlers/memories/create-firm.ts` — firm (organization) writes,
  separate handler with the dedicated static `firmMemory.create` permission in
  `config`; owner/admin role mappings grant create/update and all lower roles
  are denied. Body `scope` is fixed to `organization`.
- `apps/api/src/handlers/memories/routes.ts` — thin route file:
  `POST /memories` (user/matter) and `POST /organization/memories` (firm). Mount
  in the API root router.
- `apps/web` — a "Save to memory" affordance in chat + handling of the tool's
  proposal; inline call via Eden treaty (no single-use mutation hook).

### Phase 2 — Read / inject

- `apps/api/src/handlers/chat/memory-context.ts` — `buildMemoryPromptParts({
  organizationId, userId, contextMatterIds })`: fetch `active`+`pinned`+recent
  per scope, bound to top-N, token-budgeted; emit one labelled block ordered
  matter → user → firm so precedence is explicit to the model.
- `apps/api/src/handlers/chat/chat-prompt.ts` — append the memory block to the
  **`untrustedSuffix`**, not the `safePrompt` / `cacheStablePrefix` and not the
  `userContext` seam (both feed the no-anonymization safe half). Memory thus
  crosses the chat anonymizer like all other user-supplied context. Matter memory
  is keyed to `contextMatterIds`; RLS + `sourceDataWorkspaceIds` already prevent
  cross-matter leakage at the query layer.
- Stamp `lastUsedAt` async on injected memories (fire-and-forget, batched).

### Phase 3 — Manage UI + audit

- `apps/api/src/handlers/memories/list.ts` — `GET /memories?scope=&cursor=&limit=`
  via `createSafeRootHandler` (spans scopes; RLS enforces visibility), returning
  `Page<T>` (cursor over `(createdAt, id)`); `limit` is schema-validated with a
  default and a hard maximum (1–100), so the result set is always bounded.
- `apps/api/src/handlers/memories/update.ts` — `PATCH /memories/:id`
  (`createSafeRootHandler`) for pin/edit/status (accept suggestion → `active`,
  dismiss → `archived`). Editing a firm memory requires the same firm permission
  as the firm create handler. No delete endpoint.
- Audit: every create/update calls `createAuditRecorder` (`audit-log.ts`) in the
  same transaction (resourceType `ai_memory`), per plan 011.
- `apps/web` — a "Memory" panel grouped by scope (firm / mine / this matter),
  showing provenance ("learned from message X on date Y"), with pin/edit/archive
  and a suggestions review queue.

### Phase 4 — Suggest-first extractor + curator

- `apps/api/src/lib/scheduler/tasks/memory-extractor.ts` — reads recent
  `chatThreadCompactions.summaryMarkdown` (Decisions / Constraints / Critical
  Context) **and the message range that summary replaced**
  (`firstSummarizedMessageId`..`lastSummarizedMessageId`, rendered by
  `lib/memory/compaction-transcript.ts`). The summary is written for
  conversational continuity, so a preference stated once is exactly what it
  drops; compaction is a checkpoint rather than a delete, so the original
  messages are still readable. Both blocks enter the prompt inside separate
  untrusted delimiters, escaped and hard-capped. Provenance is unaffected:
  `sourceDataWorkspaceIds` still comes from the thread's `dataWorkspaceIds`,
  never from extracted text, so the transcript cannot widen the ethical wall.
  Proposes memories as `status: "suggested"`, setting
  `sourceDataWorkspaceIds` from the source thread's `dataWorkspaceIds` /
  `contextMatterIds`. Matter-specific kinds (`fact|decision|relationship`) are
  proposed **only** at `workspace` scope — never promoted into user/firm scope.
  Runs the `"fast"` model role on the **batch** service tier so it costs ~0
  credits and does not pollute the live prompt cache. Auto-`active` only for
  low-risk `user` `preference` kind behind a per-user setting; matter/firm always
  suggested.
- `apps/api/src/lib/scheduler/tasks/memory-curator.ts` — inactivity-triggered;
  lifecycle `active → stale@30d → archive@90d`; dedup via `supersededById`;
  pinned bypass; **never deletes**; dismissed suggestions are not re-proposed.
- Export a task-name constant + fn from each task file and **register both in
  `createSchedulerTaskRegistry` (`apps/api/src/lib/scheduler/registry.ts`)** — not
  only as rows in `jobs.ts`. Rows without a registry entry log "No scheduler task
  registered" and never run.

## Test Cases

- **RLS / ethical wall (critical):** a `workspace`-scoped memory in matter A is
  invisible to a session scoped to matter B; user memory invisible to other
  users; firm memory readable org-wide.
- **Provenance gating (critical):** a `user`-scoped memory with
  `sourceDataWorkspaceIds = [A]` is invisible once the lawyer loses access to
  matter A (the `<@` subset check), even though it is their own user memory.
- **Prompt trust bucket (critical):** memory content lands in `untrustedSuffix`
  and is run through the chat anonymizer; it never appears in `safePrompt` /
  `cacheStablePrefix`.
- **CHECK constraint:** rejects `user` scope with a `workspaceId`; `organization`
  scope with any id; `workspace` scope with a `userId`; and a `fact`/`decision`/
  `relationship` `kind` at `user` or `organization` scope.
- **Firm-write gating:** firm writes/edits go through the org-permissioned route;
  a member without the permission is rejected, an admin succeeds; the `remember`
  tool and the user/matter endpoint cannot create firm memory at all.
- **Precedence:** when matter + user + firm memories conflict on the same
  preference, the matter value is the one injected/applied.
- **Suggest-first:** extractor output lands as `suggested`; accept →
  `active` (injected), dismiss → `archived` (never re-proposed). Nothing
  auto-commits except opted-in user preferences.
- **Archive-only:** direct memory deletion is denied; curator transitions and
  supersedes only. Cascading parent deletion is the explicit tenant-erasure
  exception.
- **Pagination:** list endpoint returns a stable `Page<T>`; cursor round-trips,
  the default is 50, and the hard maximum is 100.
- **Anon tolerance:** memory resolver with no user/workspace returns empty,
  doesn't throw.

## Security Implications

- Matter isolation (ethical wall) and per-user privacy enforced at RLS, not in
  handler code — same predicate family as `chatThreads`.
- Suggest-first + archive-only + audit trail = data minimization, reversibility,
  and an actor/timestamp for every mutation (SOC 2 CC7.2 / ISO A.12.4).
- Firm-scope writes are least-privilege gated.
- Memory content enters the model prompt: it goes in the **untrusted-aware**
  assembly path (`untrustedSuffix`); treat stored content as data, never as
  instructions that can override core rules / the anonymization boundary.

## Review Revisions (2026-06-13)

Adversarial review of v1 of this plan; all findings verified against the code and
folded in above.

- **[High] Trust/cache bucket.** Memory moved out of `safePrompt` /
  `cacheStablePrefix` (verbatim, no anonymization) and the `userContext` seam
  (also the safe half) into `untrustedSuffix`.
- **[High] Cross-matter side channel.** Added `sourceDataWorkspaceIds` + `<@`
  RLS subset check and kind-by-scope restriction (matter-specific kinds only at
  `workspace` scope); extractor never promotes matter facts to user/firm.
- **[High] Firm-write gating.** Static permissions can't branch on `body.scope`;
  firm writes split to `POST /organization/memories` with a real static
  `firmMemory.create` permission; updates require `firmMemory.update`.
- **[High] Handler scope.** Multi-scope endpoints use `createSafeRootHandler`
  (not the workspace-scoped `createSafeHandler`), validating `workspaceId`
  against `accessibleWorkspaces`.
- **[Med] CHECK constraint.** Fixed to valid SQL (`IS NULL`/`IS NOT NULL`),
  made ids mutually exclusive, folded in kind-by-scope; noted composite FK for
  workspace↔org tenant integrity.
- **[Med] Scheduler registry.** Tasks must be registered in
  `createSchedulerTaskRegistry`, not only as `jobs.ts` rows.
- **[Low] Migration command.** `bun --filter @stll/api db:migrate` (root exposes
  only `db:push`).
