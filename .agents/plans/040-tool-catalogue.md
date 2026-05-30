# Plan: Jurisdiction-Aware Tool Catalogue + Onboarding Pack

Date: 2026-05-29

## Goal

A community-contributable, jurisdiction-aware catalogue of Skills,
MCP connectors, and first-party native tools. External contributors
PR new entries and edits; the maintainer marks a subset as
**recommended** per jurisdiction; new users see a marketplace-style
onboarding step that greets them, offers a one-click "Recommended
pack" install for their jurisdiction, and lets them browse and pick
individual items below.

## Design Decisions

- **Raycast-style per-entry folder layout, in-tree.** A new
  `packages/catalogue/` directory holds one folder per entry, e.g.
  `packages/catalogue/skills/contract-review-cz/` containing
  `manifest.yaml`, the skill content (`skill.md` + optional
  resources), and `icon.svg`. Same shape as Raycast's `extensions/`
  monorepo, which proves the pattern scales to thousands of entries.

- **Skill content lives in our repo, not at the author's URL.**
  Pointer-only would let an author swap content after the
  recommendation was granted (bait-and-switch), and would block
  community edits. In-tree content means: (a) "recommended"
  endorses the bytes at a specific commit; (b) anyone can PR a
  typo fix or a jurisdictional update to anyone's skill, same as
  bug fixes to a Raycast extension.

- **MIT or compatible permissive license required for in-tree
  entries.** Enforced in CI by parsing the manifest's `license`
  field against an allowlist (`MIT`, `Apache-2.0`, `BSD-2-Clause`,
  `BSD-3-Clause`, `CC0-1.0`, `CC-BY-4.0`). Raycast's MIT-only rule
  is the precedent; the wider permissive set fits Stella's
  multi-author legal-research reality. Anything copyleft or
  ambiguous gets rejected at PR time.

- **One catalogue, three internal `kind`s.** `kind: "skill" |
  "mcp" | "native-tool"`. Users see one marketplace; the
  discriminator is an implementation detail. Designed so a fourth
  `kind` can land later (templates, citation styles, etc.) without
  reworking the shape — but the v1 scope stays at these three.

- **Stella is not a plugin platform.** The catalogue is a curated
  extension surface, not a generic API for arbitrary code. Skills
  are LLM-evaluated prompts (no code execution); MCPs run remotely
  under the user's own auth; native-tools are first-party. None of
  these require sandboxing arbitrary contributor code inside the
  app — which is why this scope is feasible. Future "let everyone
  ship a UI widget" pressure should be resisted; it's a different
  product.

- **MCP entries stay as URL pointers.** MCPs run remotely by
  protocol — we can't host them. The *manifest* (description,
  auth scopes, jurisdictions, recommendation, docs URL) is in-tree
  and community-editable. Server-behaviour drift is an industry
  problem shared with Smithery, Cline, and Anthropic; mitigated
  by curation + delisting on report, not by structural
  cryptography.

- **Native-tools (pseudoMCPs) collapse into the same catalogue.**
  Existing native tools (ARES, BOE, web-search) plus new
  first-party entries (Infosoud CZ, Czech Commercial Registry,
  EUR-LEX) all become `kind: "native-tool"` folders. Their `slug`
  matches a backend handler in `apps/api/src/lib/`. "First-party"
  is a derived badge from `author: "stella"`, not a separate
  concept.

- **Recommendation is one maintainer-only file.**
  `packages/catalogue/recommended.json` maps jurisdiction code →
  list of slugs. CODEOWNERS restricts edits to maintainers; the
  rest of the catalogue is open-PR. No DB column, no per-entry
  `recommended` field, no CI logic checking field-level flips.
  Curation history lives in git.

- **Per-skill size cap of 10 MB.** Enforced in CI on PR. Keeps the
  repo lean and stops anyone trying to ship a 200 MB knowledge
  corpus as a "skill." Skills that genuinely need heavy reference
  data are out of scope for v1 — that's a different problem.

- **Manifest format: JSON, schema-validated.** `manifest.json` per
  entry. Bun supports JSON imports natively
  (`with { type: "json" }`, same pattern `skills.gen.ts` uses
  today). `$schema` reference enables IntelliSense in editors for
  contributors. Valibot schema in `packages/catalogue/src/schema.ts`
  runs in CI on every PR; a single schema describes all three
  kinds via discriminated union on `kind`.

- **Install plumbing reuses existing handlers.** Skill install →
  `agent_skills` row (existing upload handler; `origin: "bundled"`
  added alongside `"upload" | "url"` so we don't lie about source).
  MCP install → `mcp_connectors` row + `create-connection`.
  Native-tool install → `nativeToolOverrides[slug] = true` on
  `organization_settings`. No new install paths.

- **Catalogue endpoint is read-only and stateless.**
  `GET /catalogue` returns the merged manifest with computed
  `isRecommendedForOrg` (slug appears in `recommended.json` under
  any of the org's jurisdictions) and `installState`
  (`"installed" | "available" | "unavailable"`). Filtering and
  search happen client-side; the manifest is small enough to
  ship whole.

- **Install pack is frontend orchestration, not a backend
  transaction.** Pack install fires N parallel per-entry install
  mutations; partial failure surfaces per entry. A transactional
  endpoint would hide failures and force backend logic to know
  every install path.

- **Onboarding step is conditional.** Shown only when the chosen
  jurisdiction has ≥1 entry in `recommended.json`. Otherwise the
  wizard skips it. Always Skippable when shown.

- **Marketplace UI is shared between onboarding and settings.**
  The component renders the same in both contexts; onboarding adds
  the progress bar, greeting copy, and Skip button. The route
  `/_protected/settings/catalogue` is the long-term home.

- **Telemetry on the funnel.** `catalogue_step_shown`,
  `catalogue_pack_installed` (with count), `catalogue_item_installed`
  (with slug + kind), `catalogue_step_skipped`.

## Scope

**In scope:**

- New `packages/catalogue/` package: Valibot schema, per-entry
  folder structure, loader, CI validator (schema, license
  allowlist, size cap), CONTRIBUTING.md.
- Migration of existing native-tool data from
  `apps/api/src/handlers/mcp-connectors/catalog-metadata.ts` into
  `packages/catalogue/native-tools/{ares,boe,web-search}/`. The
  helpers become thin wrappers sourcing from
  `@stll/catalogue`.
- Initial pseudoMCP entries authored by the maintainer: Infosoud
  CZ, Czech Commercial Registry, EUR-LEX. Catalogue manifests
  land here; backend query implementations land separately.
- `recommended.json` with initial CZ/SK/EU recommendations
  authored by the maintainer.
- CODEOWNERS entry restricting `recommended.json` to maintainers.
- Backend `GET /catalogue` handler.
- Frontend `<CatalogueBrowser />` component (kind tabs,
  jurisdiction filter, license/pricing chips, per-entry install
  button, first-party badge).
- One-click "Install recommended pack" action with per-item
  progress + retry.
- New onboarding step `catalogue-step.tsx`, slotted after
  `jurisdiction`. Conditional render.
- New route `/_protected/settings/catalogue`.
- `agent_skills.origin` extended to include `"bundled"`.
- i18n keys for catalogue copy across all 12 languages.

**Out of scope:**

- Turning Stella into a generic plugin platform. The catalogue is
  three curated extension surfaces, not an arbitrary-code API.
- Hosted registry / remote catalogue service.
- Per-skill or per-MCP rating system.
- Auto-suggest from usage telemetry. Curation stays human.
- Transactional pack install backend.
- Paid-tool checkout. Paid items link out; install stores
  credentials only.
- Migrating existing per-org custom MCP connectors. Those remain
  org-private rows; the catalogue is for shared entries.
- Localised entry copy. English source in v1; UI chrome
  translated, entry strings not.
- Heavy skill knowledge corpora. 10 MB cap; bigger needs are a
  different problem.

## Implementation

### New package

- `packages/catalogue/package.json` — `@stll/catalogue`.
- `packages/catalogue/src/schema.ts` — Valibot discriminated union
  on `kind`. Common fields: `slug`, `displayName`, `description`,
  `author`, `authorUrl`, `license` (SPDX picklist),
  `pricing` (`"free" | "paid" | "freemium"`), `homepage`,
  `tags`, `jurisdictions`. Kind-specific:
  - skill: `entryPath` (relative to folder), optional `resources`
  - mcp: `url`, `authType`, `oauthRequestedScopes`, `documentationUrl`,
    `tokenHelpUrl`
  - native-tool: `backendSlug` (must match a backend handler)
- `packages/catalogue/src/index.ts` — `loadCatalogue()` globs
  `*/<kind>/<slug>/manifest.yaml`, validates, returns typed
  entries.
- `packages/catalogue/scripts/validate.ts` — CI entry: parses all
  manifests, enforces license allowlist, enforces per-entry 10 MB
  cap, checks slug uniqueness across the whole catalogue.
- `packages/catalogue/recommended.json` — `{ [jurisdiction]: [slug] }`.
- `packages/catalogue/MAINTAINERS` — handles authorised to edit
  `recommended.json`.
- `packages/catalogue/CONTRIBUTING.md` — entry shape, licence
  policy, icon convention, review expectations.
- `packages/catalogue/skills/...`,
  `packages/catalogue/mcps/...`,
  `packages/catalogue/native-tools/...` — entries.

### Backend

- `apps/api/src/handlers/catalogue/list-catalogue.ts` — new
  `GET /catalogue`. Loads manifest via `@stll/catalogue`, reads
  org's `practiceJurisdictions` + already-installed sets, returns
  merged entries with `isRecommendedForOrg` and `installState`.
- `apps/api/src/handlers/catalogue/routes.ts` — wire `/catalogue`.
- `apps/api/src/handlers/mcp-connectors/catalog-metadata.ts` —
  refactor to source `NATIVE_TOOL_CATALOG` from `@stll/catalogue`.
  Exported helpers unchanged.
- `apps/api/src/db/schema.ts` — extend `AGENT_SKILL_ORIGINS` with
  `"bundled"`.

### Frontend

- `apps/web/src/routes/_protected/settings/catalogue.tsx` —
  standalone route.
- `apps/web/src/routes/_protected/settings/-components/catalogue-browser.tsx` —
  shared component. Props: `mode: "onboarding" | "settings"`.
- `apps/web/src/routes/_protected/settings/-components/catalogue-entry-card.tsx`.
- `apps/web/src/routes/_protected/settings/-components/install-pack-button.tsx` —
  parallel installs, per-item progress + retry.
- `apps/web/src/routes/onboarding/-components/steps/catalogue-step.tsx` —
  thin wrapper around `<CatalogueBrowser mode="onboarding" />`.
- `apps/web/src/routes/onboarding/-components/onboarding-wizard.tsx` —
  add `"catalogue"` to `Step`, slot after `jurisdiction`, bump
  `TOTAL_STEPS` to 6.
- `apps/web/src/i18n/langs/en.json` + 11 other langs — `catalogue.*`
  keys.

### CI

- Existing workflow runs `bun run --filter @stll/catalogue validate`.
- CODEOWNERS pattern restricts `recommended.json`.

### Security

- `GET /catalogue` is workspace-scoped (`workspace: ["read"]`).
- Install mutations gated by existing handlers; no new auth
  surface.
- Icons must be committed in-tree (per-entry `icon.svg`); no
  remote `iconUrl` field. Avoids tracker pixels and SSRF from
  contributor PRs.

## Test Cases

- Schema validator rejects unknown SPDX, copyleft licences,
  duplicate slugs, unknown recommendations, oversized folders.
- `GET /catalogue` returns `isRecommendedForOrg: true` only when
  `recommended.json` lists the slug under one of the org's
  jurisdictions.
- `installState` correctly identifies installed skills, MCPs,
  and native-tool overrides.
- A `native-tool` entry whose `backendSlug` doesn't match any
  handler reports `installState: "unavailable"` (no crash).
- Onboarding catalogue step is skipped when no recommendations
  exist for the chosen jurisdiction.
- One-click pack fires N parallel mutations; partial failure
  surfaces per-item; pack doesn't block wizard completion.
- Skip from catalogue step advances cleanly.
- Settings → Catalogue mirrors the same component without
  onboarding chrome.
- Author + license + pricing + first-party badges render.
- All 12 langs have `catalogue.*` keys.
- A PR edit to `recommended.json` from a non-maintainer is
  blocked by CODEOWNERS.

## Resolved Decisions

- **Pricing taxonomy: 3 values.** `free | paid | freemium`. Anything
  requiring an API key (BYOK) counts as `paid` — from the user's
  wallet perspective, money still leaves their account. The "you'll
  need an API key" install UX is handled by the existing MCP
  `authType` + `tokenHelpUrl` fields, not by a marketplace badge.
- **Native-tool backend code stays in `apps/api/src/lib/`.**
  Catalogue holds manifest + icon + recommendation only. No
  cross-cutting refactor; new pseudoMCPs add a backend handler in
  the usual place plus a catalogue folder.
- **Multi-jurisdiction packs union and dedupe.** One pack card,
  one "Install N tools" CTA, EU-wide entries appear once. Matches
  how dual-qualified lawyers actually think about their workspace.
