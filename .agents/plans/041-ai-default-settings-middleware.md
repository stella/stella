# Plan: AI Default-Settings Middleware

Date: 2026-05-30

## Goal

Stop hand-rolling per-call defaults (`temperature`, `maxOutputTokens`,
provider-specific knobs like `thinkingConfig`, `metadata.user_id`,
`safetySettings`) at every AI handler. Compose Vercel AI SDK's
`defaultSettingsMiddleware` into the existing `withInstrumentation`
chain so the model factory injects role + provider defaults; handlers
override only when they really need to.

Mirrors the shape of the caching middleware (PR #499) — same
chain, same boundary, same opt-in/override semantics — extended to
the other "every call sets the same thing" settings.

## Design Decisions

- **Reuse `defaultSettingsMiddleware` from `ai`**, not a custom
  re-implementation. It already does the right thing: merges into
  `transformParams`, caller-set values win, missing values get the
  default. Composes cleanly with the caching middleware.
- **Defaults are computed per `(role, provider)`**, not per handler.
  Role drives sampling and verbosity; provider drives which provider
  options apply.
- **Centralise in `ai-models.ts`**. A new `defaultsForRole(role,
  provider)` helper builds the settings object the middleware
  receives at factory time. Lives next to `TEMPERATURE_PER_ROLE` and
  the existing role tables.
- **Compose into the existing `withInstrumentation`**: order
  `[defaults, caching, devtools?]` so defaults set the baseline,
  caching layers cache markers on top, devtools wraps the lot. The
  order matters because the caching middleware reads
  `providerOptions` it should see merged.
- **Keep override behaviour intact**: handlers that genuinely need
  a different value (e.g. `maxOutputTokens: 32` for thread title)
  pass it inline and that value wins. No new ceremony.
- **Pull `googleMinimalThinking()` into the new defaults table**;
  delete the helper. One source of truth for "fast role on google
  should think minimally".

## Scope

**In scope:**

- New `defaultsForRole(role, provider)` helper in `ai-models.ts`
  returning `Settings` for `defaultSettingsMiddleware`.
- Tables (next to `TEMPERATURE_PER_ROLE`) covering:
  - Per-(provider, role) `providerOptions`:
    - Google `thinkingConfig` for `fast` (minimal) and `reasoning` (full).
    - Anthropic `thinking: { type: "enabled", budgetTokens }` for
      `reasoning` only.
    - OpenAI `reasoning_effort` for `reasoning` only.
    - Google `safetySettings` baseline so legal-document content
      doesn't trip default safety filters.
    - Anthropic `metadata: { user_id: <opaque hash of orgId> }` —
      compliance trail.
- Wire the middleware into `withInstrumentation` alongside the
  caching middleware.
- Update all current AI handlers to drop:
  - `temperature: getTemperatureForRole(...)` inline arg
  - `maxOutputTokens: <magic>` where the magic equals the new default
  - `providerOptions: googleMinimalThinking()` inline arg
  Keep overrides where the handler actually needs a non-default
  value.
- Delete `googleMinimalThinking()` after the last call site goes.
- Unit tests:
  - `defaultsForRole("fast", "google")` includes
    `thinkingConfig.thinkingLevel === "minimal"`.
  - `defaultsForRole("reasoning", "anthropic")` enables thinking.
  - Caller-set settings win over defaults (assert via the middleware
    composition end-to-end).

**Out of scope:**

- Native Anthropic citations migration (separate plan).
- Org-level overrides for thinking budgets or safety settings.
- Per-org `metadata.user_id` shape negotiation with anthropic
  policy — start with a SHA-truncated `orgId` hash; revisit if
  anthropic wants a specific format.

## Implementation

**Backend**

- `apps/api/src/lib/ai-models.ts` —
  - Import `defaultSettingsMiddleware` from `ai`.
  - Add `MAX_OUTPUT_BY_ROLE` table.
  - Add `defaultsForRole(role: ModelRole, provider: AIProvider,
    orgId: SafeId<"organization"> | null): Settings` helper.
  - Insert the middleware into `withInstrumentation` ahead of the
    caching middleware.
  - Threads `orgId` from `getModelForRole` /  `getModelById`
    options so anthropic `metadata.user_id` can use a hashed
    org identifier.
- `getModelForRole` / `getModelById` signatures gain
  `organizationId: SafeId<"organization"> | null` in their options
  (passed from the auth context just like `promptCachingEnabled`).
- Migrate all current AI call sites:
  - `lib/workflow/ai-generate-batch.ts`
  - `lib/bbox/ai-generate-b-boxes.ts`
  - `handlers/chat/stream-chat.ts`
  - `handlers/chat/generate-thread-title.ts`
  - `handlers/search/ai.ts` (refine + summarise)
  - `handlers/entities/organize-suggestions.ts` (both queries)
  - `handlers/case-law/analysis/generate.ts`
  - `handlers/case-law/polarity/llm-classifier.ts`
  - `handlers/properties/preview.ts`
  - `handlers/properties/suggest-prompt.ts`
  - `handlers/skills/generate-draft.ts`
  - `handlers/skills/resources/rewrite.ts`
  Each drops the boilerplate args that now come from the middleware;
  keeps any genuine per-call overrides.
- Delete `googleMinimalThinking` helper once all call sites are
  migrated.

**No frontend changes.**

**No DB schema changes.**

## Test Cases

- `defaultsForRole` returns the expected `Settings` per
  (role, provider) combo (table-driven).
- `wrapLanguageModel` with both middlewares composed: a handler
  call without `temperature` lands with `temperature: 0` at
  the provider boundary; a handler call WITH
  `temperature: 0.7` lands with `0.7`.
- Caching middleware still adds the system `cacheControl` marker
  on top of the default provider options (regression test against
  middleware ordering).
- Anthropic `metadata.user_id` is a hash, not the raw orgId
  (privacy unit test).
- Google `safetySettings` baseline is present in the resolved
  request when provider is google.
- Invariant test: the existing
  `ai-caching-invariants.test.ts` glob still passes (no new
  direct `@ai-sdk/*` model-factory imports outside `ai-models.ts`).

## Resolutions

1. `maxOutputTokens` defaults dropped from scope — audit showed
   handlers all use legitimately different values (32 for thread
   title, 180/700 for search refine/summary, 24k for organize,
   dynamic for some). No common ground to centralise.
2. Anthropic `metadata.user_id` uses
   `Bun.CryptoHasher("sha256").update(orgId).digest("hex").slice(0, 16)`.
3. `thinking` budget stays a code-side default; org-level
   override deferred to a future change request.
