# Plan: AI Prompt-Caching Toggle

Date: 2026-05-29

## Goal

Add a single org-level prompt-caching toggle (default ON) that all AI
calls in the system obey by construction, via Vercel AI SDK middleware
wired into the existing model factory. Replaces today's silent
"no caching" baseline with an explicit, customer-controlled switch;
unlocks 5–10× input-token reduction on workflow extraction and chat
without changing any call site behaviour.

## Design Decisions

- **Middleware over per-call-site discipline.** Every model returned
  from `ai-models.ts` is already wrapped by `withLocalAIDevTools`
  (`wrapLanguageModel`). Add a second middleware in the same chain
  that injects per-provider cache markers (Anthropic
  `cacheControl: ephemeral`, OpenAI `promptCacheKey`) when ON and
  strips any present markers when OFF. Call sites stay clean; new
  call sites can't bypass the policy.
- **Single source of truth = `resolveCaching(...)`.** Returns a
  discriminated `CachingDecision`. Middleware and content-part
  helper read from the same function.
- **Default ON for cost + latency; OFF as an explicit compliance
  choice.** UI copy names the trade-off honestly — the toggle
  controls *whether stella sends cache markers/keys*, not whether
  the provider caches server-side (providers may auto-cache
  opportunistically; only ZDR truly disables, a later concern).
- **Boolean lives outside the encrypted blob.** Prompt-caching
  preference isn't sensitive and applies to instance-mode orgs
  without BYOK too. New plain column
  `prompt_caching_enabled BOOLEAN NOT NULL DEFAULT TRUE` on
  `organization_settings`. Survives "delete AI config" cleanly.
- **Content-part cache breakpoints via helper, not free text.**
  `markCacheBreakpoint(part, { scope, decision })` is the only
  sanctioned way for call sites to mark user-content parts as
  cacheable. Prevents Anthropic-specific `cacheControl` literals
  leaking into call sites that may resolve to another provider.
- **Scope key required on every model factory call, but nullable.**
  `getModelForRole` / `getModelById` gain a required
  `{ scopeKey: string | null }` option. `null` is a legitimate
  choice meaning "no routing key, opportunistic only" — keeps
  type-level discipline without forcing every surface to invent
  a hash. Stable ids (entityVersionId, threadId, the chat handler's
  existing prompt-cache hash) are preferred where natural.
- **Lint enforcement.** Custom oxlint rule forbidding direct
  imports of `streamText` / `generateText` / `streamObject` /
  `generateObject` from `ai` outside `ai-models.ts` and the
  caching helper module. Matches the existing wrap-at-every-
  callsite convention.
- **Rename `withLocalAIDevTools` → `withInstrumentation`.** The
  function will host two middlewares now (devtools + caching);
  the new name reflects scope. Done in this PR.

## Scope

**In scope:**

- New plain column `organization_settings.prompt_caching_enabled`
  (default `true`) + migration.
- `loadOrgAIConfig` returns `{ orgAIConfig, promptCachingEnabled }`;
  `OrgAIConfig` itself stays BYOK-only.
- `CachingDecision` + `resolveCaching` in
  `apps/api/src/lib/ai-models.ts` (or a sibling module).
- `cachingMiddleware` wired into `withInstrumentation`.
- `markCacheBreakpoint` helper for content-part cache marking.
- `getModelForRole` / `getModelById` signature gains `{ scopeKey }`;
  all existing call sites updated.
- `ai-generate-batch.ts` marks one breakpoint **before**
  `buildPromptsMessage` (after files + textInputs) so document
  content is reused across different property sets on the same
  entity.
- `stream-chat.ts` drops the hand-rolled
  `providerOptions.openai.promptCacheKey` block; passes its
  existing `buildChatPromptCacheKey` output as `scopeKey` so the
  OpenAI cache shard stays identical (no one-time cache miss).
- Settings UI: one switch in general organization settings (not a
  dedicated AI panel, not onboarding) with copy explaining cost vs.
  compliance trade-off.
- Audit log: `org.ai.caching_toggled` events.
- Custom oxlint rule + invariant test forbidding direct
  `ai`-package imports outside the boundary.
- Per-call telemetry: capture `cache_creation_input_tokens` and
  `cache_read_input_tokens` from Anthropic `onFinish`, surface in
  the existing `aiAnalytics` callbacks.

**Out of scope:**

- ZDR fields on `OrgAIProviderConfig` and instance ZDR registry.
- Google explicit `CachedContent` lifecycle.
- Per-matter caching override.
- Anonymizer changes / PII gating tied to the toggle.
- Provider-side ZDR contract detection.
- Anthropic 1-hour extended TTL (v1 uses 5-minute ephemeral only).
- Pricing / credits split for cached vs uncached metered calls.

## Implementation

**Backend**

- `apps/api/src/db/schema.ts` — add
  `promptCachingEnabled: boolean("prompt_caching_enabled").notNull().default(true)`
  on `organizationSettings`.
- Drizzle migration generated via the project's standard flow
  (`bun --filter @stll/api db:push` or equivalent).
- `apps/api/src/lib/ai-config-loader.ts` — keep `loadOrgAIConfig`
  returning `OrgAIConfig | null`; add a sibling
  `loadPromptCachingPreference(organizationId): Promise<boolean>`
  reading the new column. Default `true` if the column is null
  (shouldn't happen post-migration, defensive only). Call sites
  that need both load them in parallel.
- `apps/api/src/lib/ai-models.ts` —
  - Add `CachingDecision`,
    `resolveCaching({ orgConfig, promptCachingEnabled, role, scopeKey })`.
  - Add `cachingMiddleware(decision, provider)` implementing
    `transformParams`.
  - Rename `withLocalAIDevTools` → `withInstrumentation`; chain
    devtools + caching middlewares.
  - Update `getModelForRole` / `getModelById` signatures to take
    `{ promptCachingEnabled, scopeKey }` and pass through.
  - Update `byokCacheKey` to include the caching decision so
    cached factories don't go stale when the toggle flips.
- `apps/api/src/lib/ai-caching.ts` (new) — `markCacheBreakpoint`
  helper. Inspects the resolved provider via the decision and
  returns a part with provider-specific cache markers or untouched.
- `apps/api/src/lib/workflow/ai-generate-batch.ts` —
  - Add `scopeKey: entityVersionId` to `getModelForRole`.
  - Wrap the last static content part (after files + textInputs,
    *before* `buildPromptsMessage`) with `markCacheBreakpoint`.
- `apps/api/src/handlers/chat/stream-chat.ts` —
  - Drop `providerOptions.openai.promptCacheKey` from the
    `streamText` call.
  - Pass the existing `promptCacheKey` value as `scopeKey` to
    `getModelForRole`.
- All other AI handlers (`bbox/ai-generate-b-boxes.ts`,
  `handlers/search/ai.ts`,
  `handlers/entities/organize-suggestions.ts`,
  `handlers/case-law/polarity/llm-classifier.ts`,
  `handlers/case-law/analysis/generate.ts`,
  `handlers/chat/generate-thread-title.ts`,
  `handlers/properties/preview.ts`,
  `handlers/properties/suggest-prompt.ts`) — add `scopeKey` to
  `getModelForRole`. For surfaces without an obvious stable id,
  use `${orgId}:${role}:${sha256(input).slice(0, 16)}` so OpenAI
  still gets routing benefit on identical inputs and Anthropic
  prefix-cache works whenever inputs repeat.
- `apps/api/src/handlers/organization-settings/update-ai-config.ts`
  (and sibling read/delete paths) — accept and persist the new
  boolean; emit audit event `org.ai.caching_toggled` with actor
  and before/after.
- Custom oxlint rule under the existing plugin location forbidding
  `streamText` / `generateText` / `streamObject` / `generateObject`
  imports from `ai` outside `ai-models.ts` and `ai-caching.ts`.

**Frontend**

- Frontend: add a switch row in the existing general
  organization-settings page (not the AI-config panel, not the
  onboarding wizard); i18n keys typed via `TranslationKey`.

**DB schema changes**

- `organization_settings.prompt_caching_enabled BOOLEAN NOT NULL DEFAULT TRUE`
  (additive, safe rollout).

## Test Cases

- Unit: `resolveCaching` returns
  `{ enabled: false, reason: "org-disabled" }` when the toggle is
  off and `{ enabled: true, ttl, scopeKey }` when on.
- Unit: `cachingMiddleware.transformParams` adds
  `providerOptions.anthropic.cacheControl: ephemeral` on system +
  designated content parts when ON for Anthropic; adds
  `providerOptions.openai.promptCacheKey` when ON for OpenAI /
  Azure; adds nothing for Google / Mistral / OpenRouter.
- Unit: middleware **strips** all of `cacheControl`,
  `promptCacheKey`, `cachedContent` from `providerOptions` when
  OFF, regardless of provider.
- Unit: `getModelForRole` requires `scopeKey` (compile-time
  guard).
- Unit: `byokCacheKey` differs when `promptCachingEnabled` flips,
  so cached factories rebuild.
- Integration: run extraction twice within 5 min with ON → second
  call reports `cache_read_input_tokens > 0` (mock provider or
  designated live integration suite).
- Integration: same with OFF → both calls report
  `cache_read_input_tokens == 0` and
  `cache_creation_input_tokens == 0`.
- Invariant test (per testing convention): glob
  `apps/api/src/handlers/**/*.ts`, fail if any direct import of
  `streamText` / `generateText` / `streamObject` / `generateObject`
  from `ai`.
- Audit: toggling the setting writes an `org.ai.caching_toggled`
  row with actor + before/after.
- Frontend: toggle round-trips through the form and persists;
  default state on a fresh org is ON.

## Resolutions

1. Chat handler passes its existing `buildChatPromptCacheKey`
   output as `scopeKey`, preserving the same OpenAI cache shard;
   no one-time cache miss.
2. AI surfaces without an obvious stable id use
   `${orgId}:${role}:${sha256(input).slice(0, 16)}` as their
   `scopeKey` — keeps OpenAI routing tight and lets Anthropic
   prefix-cache work on repeat inputs.
3. Cache breakpoint sits **before** `buildPromptsMessage` —
   document content (the expensive part) is reused across
   different property sets on the same entity.
4. `withLocalAIDevTools` → `withInstrumentation` rename ships in
   this PR.
