---
name: model-catalog-check
description: "Fix failures from the nightly Model Catalog Upstream Check workflow (.github/workflows/model-catalog-check.yml). Run when check:model-catalog fails in CI."
---

# Model Catalog Upstream Check — Repair Agent

Fix failures from the nightly **Model Catalog Upstream Check** workflow
(`.github/workflows/model-catalog-check.yml`).

## Trigger

Run this skill when:

- `.github/workflows/model-catalog-check.yml` fails in GitHub Actions, or
- `bun run check:model-catalog` exits non-zero locally.

Typical CI log line:

```text
✗ N offered model ID(s) need attention:
  ✗ [LABEL] provider / modelId — detail
```

## Goal

Make `bun run check:model-catalog` pass on `main` (or a repair branch
off `main`) with the smallest correct catalog change. Open a draft PR
that restores the nightly check to green.

This workflow is **not** part of `bun run verify`. Only run the catalog
check and its unit tests; do not run the full monorepo verify unless
you touched unrelated files.

## What the check validates

Script: `packages/scripts/src/model-catalog-upstream.ts`
Command: `bun run check:model-catalog`

It collects every model ID Stella offers from `@stll/ai-catalog`:

- `BYOK_MODEL_OPTIONS` (BYOK picker + API allowlist)
- `DEFAULT_MODELS` / `BYOK_DEFAULT_MODELS` (role defaults)

Then validates against live, public, keyless upstream listings:

| Source | Used for |
| --- | --- |
| [models.dev](https://models.dev/api.json) | First-party providers (`google`, `openai`, `anthropic`, `mistral`): existence, `status: "deprecated"`, cost metadata |
| [OpenRouter](https://openrouter.ai/api/v1/models) | `openrouter/*` slugs: routing availability |

**Skipped providers** (custom deployment IDs, no public catalog):
`azure_foundry`, `bedrock`, `huggingface`, `openai_compatible`.

### Failure labels

| Label | Meaning |
| --- | --- |
| `[DEPRECATED]` | models.dev marks the model `status: "deprecated"` |
| `[MISSING]` | Model absent from the authoritative upstream listing |
| `[NO RATE]` | Offered first-party model has no `MODEL_RATES` entry |
| `[NO CACHED RATE]` | Upstream publishes `cache_read` pricing but the rate entry lacks `cachedInputPerMTok` |
| `[RATE DRIFT]` | `MODEL_RATES` entry no longer matches upstream cost metadata (median-normalized, 1% tolerance) |
| `[UNVERIFIED]` | Upstream fetch failed; warning only unless **every** model is unverified |

## Workflow

### 1. Reproduce

```bash
git fetch origin main
git checkout -b cursor/model-catalog-repair-XXXX main   # use your branch suffix
bun install --ignore-scripts
bun run check:model-catalog
```

Copy the full failure block from CI or local output. Each line is one
independent fix target unless the same root cause affects multiple IDs
(e.g. a renamed successor model).

### 2. Classify each failure

For each `✗ [LABEL] provider / modelId` line, pick **one** primary
resolution path (in preference order):

#### A. Model retired upstream → remove or migrate

Use when `[MISSING]` or `[DEPRECATED]` and the provider has shut down
(or marked deprecated with no intent to keep serving).

1. Confirm upstream status:
   - First-party: fetch `https://models.dev/api.json`, inspect
     `providers[provider].models[modelId]`.
   - OpenRouter: fetch `https://openrouter.ai/api/v1/models`, search
     for the slug.
   - Provider docs / changelog (web search) for the official successor ID.
2. If a direct successor exists and Stella should keep offering the
   capability, **migrate**:
   - Replace the old ID everywhere it appears in
     `packages/ai-catalog/src/index.ts`:
     `BYOK_MODEL_OPTIONS`, `BYOK_DEFAULT_MODELS` / `DEFAULT_MODELS`,
     `BYOK_DOCUMENT_INPUT_MODEL_OPTIONS` (when applicable),
     `ANTHROPIC_ADAPTIVE_THINKING_MODELS`,
     `ANTHROPIC_FIXED_SAMPLING_MODELS`, `CONTEXT_WINDOW_TOKENS`.
   - Add/update `MODEL_RATES` for the successor (see rate formula below).
   - Search the repo for the old ID string; update any remaining
     references (tests, docs, snapshots).
3. If no successor or Stella should drop the model, **remove** it from
   the catalog lists above and pick a new default for any role that
   pointed at it.
4. Do **not** leave a dead ID in `BYOK_MODEL_OPTIONS` or defaults.

#### B. Upstream repriced → refresh `MODEL_RATES`

Use when `[RATE DRIFT]` or `[NO CACHED RATE]` / `[NO RATE]`.

**Rate normalization** (must match the rest of the table):

```text
inputPerMTok        = upstream_cost.input        × 100_000
outputPerMTok       = upstream_cost.output       × 100_000
cachedInputPerMTok  = upstream_cost.cache_read   × 100_000   (when published)
```

Upstream costs live under `cost.input`, `cost.output`, `cost.cache_read`
in models.dev (USD per 1M tokens). Stella stores **micro-units** per 1M
tokens (factor `100_000` micro-units per upstream dollar). See
`packages/scripts/src/model-catalog-rates.test.ts`.

Steps:

1. Read upstream cost for `${provider}:${modelId}` from models.dev.
2. Update the entry in `MODEL_RATES` inside
   `packages/ai-catalog/src/index.ts`.
3. If upstream publishes `cache_read`, set `cachedInputPerMTok`; do not
   omit it.
4. Keep retired models in `MODEL_RATES` only when historical ledger rows
   still reference them; the `satisfies Record<OfferedFirstPartyModelId,
   ModelRate>` constraint requires every **currently offered**
   first-party model to have an entry.

#### C. Temporary upstream lag → acknowledge (last resort)

Use only when Stella **must** keep offering the model and upstream
divergence is **known and temporary**:

- Brand-new model not yet indexed by OpenRouter/models.dev.
- Deprecated upstream but still serving until a documented shutdown date.
- Deliberate rate divergence (rare; prefer updating rates).

Add to `ACKNOWLEDGED` in `packages/scripts/src/model-catalog-upstream.ts`:

```typescript
const ACKNOWLEDGED = new Set<AcknowledgementKey>([
  "provider:canonicalid", // added YYYY-MM-DD; reason
]);
```

**Acknowledgement key rules:**

- Format: `` `${provider}:${canonicalId}` ``
- `canonicalId` = lowercase, strip `.`, `-`, `_` from the native model ID
  (OpenRouter: keep provider prefix, same normalization).
- Examples:
  - `openai:gpt54` for `gpt-5.4`
  - `openrouter:openai/gpt54` for `openai/gpt-5.4`
  - `mistral:mistralmedium35` for `mistral-medium-3-5`

**Always include a dated comment.** Never use `ACKNOWLEDGED` to hide a
permanent removal or stale rates you should fix.

For ID aliases models.dev does not index under the exact native key, use
`FIRST_PARTY_ALIAS_FALLBACK` (same key format, dated comment) only when
the model exists upstream under a different canonical form.

#### D. Infrastructure failure → do not patch the catalog

If the log shows upstream unreachable for all models:

```text
✗ No offered model IDs were verified because every authoritative source was unavailable.
```

Or every line is `[UNVERIFIED]`:

1. Re-run the workflow / script (transient outage).
2. If persistent, inspect OpenRouter and models.dev availability; file an
   infra issue. **Do not** add ACKNOWLEDGED entries or change the catalog
   to mask a fetch failure.

### 3. Edit the right files

| File | When to edit |
| --- | --- |
| `packages/ai-catalog/src/index.ts` | Model add/remove/rename, defaults, rates, context windows, Anthropic flags |
| `packages/scripts/src/model-catalog-upstream.ts` | `ACKNOWLEDGED`, `FIRST_PARTY_ALIAS_FALLBACK` only |
| Rest of repo | Grep for old model ID strings after catalog changes |

Primary catalog exports to keep in sync:

- `BYOK_MODEL_OPTIONS`
- `BYOK_DEFAULT_MODELS` / `DEFAULT_MODELS`
- `BYOK_DOCUMENT_INPUT_MODEL_OPTIONS`
- `MODEL_RATES`
- `CONTEXT_WINDOW_TOKENS`
- `ANTHROPIC_ADAPTIVE_THINKING_MODELS` / `ANTHROPIC_FIXED_SAMPLING_MODELS`
  (Anthropic models only)

### 4. Verify

```bash
bun run check:model-catalog
bun --filter @stll/scripts test packages/scripts/src/model-catalog-rates.test.ts
bun --filter @stll/ai-catalog typecheck
```

Fix until the catalog check prints:

```text
✓ All offered model IDs are present and current upstream.
```

Warnings like `rate consistency unverifiable (no upstream cost metadata)`
are acceptable; errors are not.

### 5. Commit and PR

- Branch: `cursor/model-catalog-repair-XXXX` (or your agent suffix).
- Commit message examples:
  - `fix: refresh mistral-medium-latest MODEL_RATES after upstream reprice`
  - `fix: migrate off deprecated gemini-3.1-flash-lite-preview`
  - `chore: acknowledge openai/new-model until OpenRouter indexes it`
- Open a **draft PR** to `main`.
- PR body: list each CI failure line, upstream evidence (URL or API
  snippet), and the resolution chosen (migrate / refresh rates /
  acknowledge / remove).
- Scope: catalog + script acknowledgement changes only. No unrelated
  refactors.

## Decision cheat sheet

```text
[MISSING] + model gone forever     → remove from catalog OR migrate to successor
[DEPRECATED] + shutdown imminent   → migrate defaults/options to successor
[DEPRECATED] + still serving       → ACKNOWLEDGED with shutdown date, plan migration
[MISSING] + brand-new model        → ACKNOWLEDGED until indexed (short-term)
[RATE DRIFT]                       → update MODEL_RATES from models.dev cost
[NO RATE]                          → add MODEL_RATES entry
[NO CACHED RATE]                   → add cachedInputPerMTok from cache_read
[UNVERIFIED] only                  → retry; do not edit catalog
```

## Common mistakes (avoid)

- Patching only `MODEL_RATES` while leaving a `[MISSING]` model in
  `BYOK_MODEL_OPTIONS`.
- Using `ACKNOWLEDGED` for rate drift (fix the rate instead).
- Forgetting to update role defaults when removing a model from options.
- Wrong acknowledgement key casing or punctuation (must match
  `acknowledgementKey()` normalization).
- Adding OpenRouter-prefixed slugs to `MODEL_RATES` (rates key off the
  native first-party ID; OpenRouter slugs are not first-party-metered).
- Running `bun run verify --all` as the gate; this check is standalone.

## Reference

- Workflow: `.github/workflows/model-catalog-check.yml`
- Check script: `packages/scripts/src/model-catalog-upstream.ts`
- Rate logic: `packages/scripts/src/model-catalog-rates.ts`
- Catalog source of truth: `packages/ai-catalog/src/index.ts`
- Ledger consumer: `apps/api/src/lib/usage/unit-model.ts`
