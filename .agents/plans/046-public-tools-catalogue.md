# Plan: Public Tools Catalogue

Date: 2026-07-02

## Goal

Open the skills + MCP + native-tool catalogue as a public, SEO-quality,
unauthenticated surface: anyone can browse, read, copy, and download
entries; contributions arrive as GitHub PRs; only maintainers can mark
entries as recommended. Composes the shipped catalogue package (plan
040) with the shipped public SSR shell pattern (plan 042).

## Design Decisions

- **Public routes at `/tools` + `/tools/$slug`.** Slugs are already
  validated as unique across kinds, so detail URLs stay flat. Matches
  the in-app "Tools" concept (`/knowledge/tools`). Kind tabs and
  practice-area/jurisdiction filters live on the index, not in the URL.
- **Public pages render from the static `@stll/catalogue` bundle, not
  an API.** The generated bundle is imported in `apps/web` (lazy route
  chunks). No new anonymous API surface, no rate limiting, and it is
  structurally impossible to leak the org-custom synthetic entries
  that `GET /catalogue` appends for logged-in orgs. Content updates
  ship with the deploy each merged PR already triggers. A public
  metrics endpoint (view/install counts) is deliberately deferred.
- **Two skill source variants: `in-tree` and `github`.** Large
  community skills (multi-MB corpora, e.g. German-law skill repos)
  must not enter this repo. A `github`-sourced skill manifest pins
  `repo` + optional `path` + `rev` (full commit SHA). Because content
  at a pinned SHA is immutable, "recommended" still endorses specific
  bytes — the anti-bait-and-switch property of plan 040 survives.
  Detail pages fetch `SKILL.md` at the pinned SHA server-side (with
  caching + timeout); zip download links to GitHub's archive at that
  SHA. The in-tree 10 MB cap stays for `in-tree` entries only.
- **Auto-update is a bot PR, not a live pointer.** A scheduled
  workflow checks upstream repos of `github`-sourced entries and opens
  a PR bumping `rev` (dependabot-style). The maintainer reviews the
  upstream diff before merging, so curation is preserved while authors
  get "autoupdate via their GitHub".
- **Contribution flow is a GitHub PR, made legible.** A public
  `/tools/contribute` page explains both entry shapes and links to the
  repo, catalogue CONTRIBUTING, and a PR template. CI validation
  (schema, SPDX allowlist, size cap, slug uniqueness) already exists.
- **Recommendation stays a maintainer-only git file.** No change to
  the mechanism: `packages/catalogue/entries/recommended.json` gated
  by MAINTAINERS/CODEOWNERS. Public pages surface it as a
  "Recommended" badge with jurisdiction chips and a jurisdiction
  filter. No DB flag, no admin UI, no way for contributors to
  self-recommend.
- **Copy and download are first-class.** Detail pages show the full
  skill markdown with copy-to-clipboard, MCP entries show a copyable
  config snippet (URL, auth type, scopes), and skills offer a zip
  download (SKILL.md + resources) usable in any assistant — the
  catalogue is assistant-agnostic on the public surface.
- **"Add to Stella" is auth-gated, not hidden.** The install button on
  public pages routes through the existing sign-in dialog with
  `redirectTo` back to the entry, then completes the install via the
  existing install plumbing. Same pattern as public-law private
  actions.
- **Reuse the public-law shell recipe wholesale.** SSR predicate
  entry, shell chrome, SEO helper (canonical/OG/JSON-LD/robots flip),
  sitemap section, launch flags mirroring `public-law-launch.ts`.
  Generalize helpers only where they are `law`-specific; do not fork
  the pattern.

## Scope

**In scope:**

- Public SSR routes: `/tools` (index: kind tabs, practice-area +
  jurisdiction filters, recommended badges), `/tools/$slug` (detail:
  about, metadata, content tab with copy, download, Add to Stella),
  `/tools/contribute`.
- `github` source variant in the skill manifest schema + loader +
  validator (pinned SHA required; license field still mandatory and
  allowlist-checked).
- Server-side fetch-and-cache of `github`-sourced skill content at the
  pinned SHA for detail rendering; zip download via GitHub archive
  link for `github` entries and an on-the-fly zip for `in-tree`
  entries.
- Scheduled auto-update workflow opening `rev`-bump PRs for
  `github`-sourced entries.
- Seed content curated by the maintainer before launch: ~5–10
  community-made skills (permissively licensed, mostly
  `github`-sourced pinned entries) and a few curated MCP manifests.
  Internal authored skills are not promoted to public seeds.
- Contribute page + PR template + catalogue CONTRIBUTING polish.
- Auth-gated "Add to Stella" round-trip on public detail pages.
- SEO: canonical URLs, OG, JSON-LD per entry, catalogue sitemap
  section, robots rules; launch + indexing feature flags.
- Public nav entry via the shared nav registry; i18n of UI chrome in
  all supported languages (entry content stays English, per plan 040).

**Out of scope:**

- View/install counters, popularity sorting, ratings (needs a public
  API + persistence; revisit after launch).
- In-browser "try it" sandbox (lawve's Try Now). Anonymous AI surfaces
  exist elsewhere but wiring them here is a separate slice.
- Hosting external skill corpora in this repo or an object store; the
  pinned-SHA fetch keeps them upstream.
- Contributor profile pages / author showcase beyond name + URL from
  the manifest.
- Localized entry content; per-entry translations stay out.
- Any change to the in-app `/knowledge/tools` page beyond sharing
  presentational components.

## Implementation

### packages/catalogue

- `src/schema.ts` — skill variant gains a `source` discriminator:
  `{ source: "in-tree", entryPath, resources }` vs
  `{ source: "github", repo, path?, rev, entryPath }`. Existing
  entries migrate mechanically to `source: "in-tree"`.
- `src/loader.ts` / `scripts/validate.ts` — validate the new variant
  (full-SHA `rev`, no size cap for `github`, license still required);
  `scripts/generate-manifest.ts` excludes github content from the
  install-payload bundle.
- New `scripts/check-upstream.ts` + `.github/workflows` cron — diff
  upstream HEAD vs pinned `rev`, open bump PRs.
- `CONTRIBUTING.md` — document both entry shapes.

### apps/web

- `src/lib/public-ssr-paths.ts` — add `/tools`.
- `src/routes/tools/route.tsx`, `tools/index.tsx`,
  `tools/$slug.tsx`, `tools/contribute.tsx` — public routes outside
  `_protected`, wrapped in the public shell (generalize
  `PublicLawShell` → shared public shell or a sibling).
- `src/routes/tools/-catalogue-detail.tsx` — shared loader/head/view
  (mirrors `law/-case-detail.tsx`); loads the static bundle chunk; for
  `github` skills, loads content via a server function with cache +
  `AbortSignal.timeout`.
- Zip: server route for in-tree skill zips (e.g. `fflate`), direct
  GitHub archive link for `github` skills.
- SEO: generalize `public-law-seo.ts` head/JSON-LD helpers; sitemap
  route `sitemaps/tools[.]xml.ts` + registration in the index +
  robots rules; flags in a `public-tools-launch.ts` mirroring
  `public-law-launch.ts` (env cross-check in `env.ts`, Dockerfile
  build args).
- Nav: add entry in `workspace-primary-nav.ts`.
- Reuse presentational pieces from
  `src/components/catalogue/` and knowledge-tools components where
  they don't depend on install state; copy/download affordances are
  new.
- i18n keys `publicTools.*` in all langs.

### apps/api

- No new public endpoints. "Add to Stella" reuses existing authed
  install handlers. `install-skill` gains support for `github`-sourced
  entries by fetching at the pinned SHA (reuse `skills/import-url.ts`
  machinery), recording origin appropriately.

### DB schema

- None expected. (`agent_skills.origin` already covers bundled/url.)

## Security

- Public pages read only the static bundle: no session, no org data,
  no DB. Keep an invariant test that public tools routes import no
  authed query modules (mirror the case-law static invariant tests).
- `github` content is fetched only from `raw.githubusercontent.com` /
  `codeload.github.com` at a pinned full SHA, with timeout and size
  limit; rendered through the existing sanitizing markdown renderer.
- Recommendation file remains CODEOWNERS-gated; public UI has no
  write path.
- Indexing flag separate from launch flag, as with public law.

## Test Cases

- Validator: rejects `github` skill without full-SHA `rev`, without
  license, or with disallowed license; still enforces 10 MB on
  in-tree entries; accepts migrated existing entries unchanged.
- Logged-out user can browse `/tools`, filter by kind/practice
  area/jurisdiction, open a detail page, copy skill markdown, copy MCP
  config, download a zip.
- Recommended badge appears exactly for slugs in `recommended.json`
  (per jurisdiction), and nothing on the public surface can set it.
- Org-custom MCPs/authored skills never appear on public pages.
- `github` skill detail renders content at the pinned SHA; upstream
  force-push does not change rendered content; fetch failure degrades
  to metadata + external link, not a crash.
- "Add to Stella" logged out → sign-in → returns and completes
  install; logged in → installs directly.
- Head output: canonical, OG, JSON-LD, robots flip with the indexing
  flag; sitemap lists all entry URLs; robots disallows when disabled.
- Flag off → routes 404/redirect (same behaviour as public law).
- Invariant test: public tools modules do not import authed/catalogue
  list-endpoint queries.

## Open Questions

- Final seed list: which community-made skills make the launch set
  (licenses must be on the allowlist; maintainer curates).
