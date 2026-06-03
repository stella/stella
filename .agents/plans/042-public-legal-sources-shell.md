# Plan: Public Legal Sources Shell

Date: 2026-06-02

## Goal

Make public legal materials a first-class Stella surface with SEO-quality pages,
while keeping real workspace data and AI/workflow features behind authentication.
Logged-out users can browse, search, and read public legal sources in the Stella
shell; login unlocks workspace, matter, document, and AI actions.

## Design Decisions

- **One shell, two permission states.** Do not build a fake workspace. Render the
  real Stella chrome with public legal sources available and private navigation
  or actions auth-gated.
- **Use a broad public namespace.** Case law is the first material type, not the
  whole architecture. Public URLs should support cases, statutes, guidelines,
  and future public legal materials.
- **Structured canonical URLs.** Public pages should use stable, descriptive
  slugs such as `/law/:country/cases/:court/:date/:slug`,
  `/law/:country/statutes/:source/:slug`, and
  `/law/:country/guidelines/:authority/:date/:slug`.
- **Elysia remains the backend source of truth.** Public and private API
  boundaries stay in `apps/api`; TanStack Start is the web rendering and SEO
  layer, not a replacement backend.
- **Migrate `apps/web` to TanStack Start.** A unified app keeps one router tree,
  shell, design system, auth model, and route context. Use selective SSR:
  public legal-source routes are SSR/prerender/indexable; private workspace
  routes remain mostly client-rendered and auth-gated.
- **Private features stay protected.** Matter links, saved notes, AI
  analysis/generation, chat, uploads, workspace views, and tenant data require
  session/org/workspace permission checks.
- **Index canonical content, not arbitrary search URLs.** Detail pages and
  curated browse pages should be indexable. Unbounded search result URLs should
  normally be `noindex` unless promoted into explicit curated pages.

## Scope

**In scope:**

- Unified TanStack Start migration for `apps/web`.
- Public legal-source routes with Stella shell.
- Case law as the first public material type.
- Auth-gated sidebar/nav items and auth-gated legal-source actions.
- Public Elysia endpoints for legal-source read/list/search data.
- Protected Elysia endpoints for matter links and AI features.
- SEO metadata, canonical URLs, `robots.txt`, `sitemap.xml`, structured data,
  and index/noindex controls.
- Login redirect back to the page/action the user attempted.

**Out of scope:**

- Making real workspaces public.
- Public access to matters, files, chats, annotations, orgs, members, or audit
  data.
- Moving domain logic into TanStack Start server functions.
- Vector/semantic search changes.
- Reworking ingestion adapters except where URL/metadata fields need
  improvement.
- Fully implementing statutes/guidelines ingestion in the first slice.

## Implementation

### Current Slice Status

Implemented on the current Vite + TanStack Router app:

- Public `/law` shell and case-law routes.
- Structured public case URLs under `/law/:country/cases/:court/:date/:slug`.
- Unauthenticated public case-law list/read/search API routes.
- Authenticated AI analysis, matter-link, and admin case-law routes remain
  protected.
- Branded public case-law read DB boundary plus static security invariant tests
  to prevent accidental auth/public mixing.
- Public decision payload excludes persisted AI analysis.

Still remaining for the full plan:

- TanStack Start migration and SSR/prerender layer for first-class SEO.
- Canonical tags, Open Graph, JSON-LD, `robots.txt`, `sitemap.xml`, and
  index/noindex policy implementation.
- Public material types beyond case law: statutes, guidelines, and curated
  browse pages.

- `apps/web/package.json` and `apps/web/vite.config.ts` — migrate the web app
  from Vite SPA-only to TanStack Start while preserving Vite, TanStack Router,
  Query, React, and existing component patterns.
- `apps/web/src/routes/__root.tsx` — stop making public page rendering depend
  on session lookup. Session can be loaded opportunistically for chrome/actions,
  but public legal-source content must render from public data.
- `apps/web/src/routes/_protected.tsx` — keep auth enforcement for
  workspace/chat/settings/document routes.
- `apps/web/src/routes/law/*` — create public legal-source index/browse/detail
  routes outside `_protected`.
- `apps/web/src/routes/law/$country/cases/*` — move or wrap the existing case
  law browser/viewer as the first public legal-source type.
- `apps/web/src/routes/_protected.knowledge/case/*` — either redirect to the
  new public case routes or keep private wrappers only for logged-in
  enhancements.
- `apps/web/src/routes/_protected.knowledge/case/-queries/decisions.ts` — split
  public decision read/search/list query options from protected AI/workspace
  query options.
- `apps/web/src/lib/case-law-route.ts` — extend route helpers for structured
  canonical case slugs and legacy `caseNumber--id` compatibility.
- `apps/web/src/components/app-sidebar` or route shell files — show public
  legal sources as available; gate private tabs with login/signup redirects when
  no session exists.
- `apps/api/src/handlers/case-law/routes.ts` — split current "global read"
  routes into truly unauthenticated public read/search/list routes and
  authenticated AI/admin/matter-link routes.
- `apps/api/src/handlers/case-law/decisions/read-by-id.ts` — ensure public
  response shape includes only public fields needed for rendering and SEO.
- `apps/api/src/handlers/case-law/decisions/list.ts` and `search.ts` — keep
  cursor pagination; add public rate/cache behavior as needed.
- `apps/api/src/lib/auth` / macros — avoid applying auth macros to public
  legal-source read routes.
- DB schema changes — probably none for the first case-law slice. Possible
  follow-up fields: canonical slug, material type, indexability flag,
  publication status, source freshness, and sitemap `lastmod`.

## Test Cases

- Logged-out user can open `/law/.../cases/...` and read a decision without
  redirects.
- Logged-out user clicking Workspaces, Chat, upload, save-to-matter, notes, or
  AI opens auth and returns to the intended page/action after login.
- Logged-in user sees the same public legal-source page plus workspace-aware
  actions.
- Public API routes return no workspace/org/private fields.
- Protected matter-link and AI routes reject unauthenticated requests.
- Public detail pages emit correct title, description, canonical, robots, Open
  Graph, and structured data.
- `sitemap.xml` includes public legal-source URLs and excludes private
  workspace URLs.
- Curated browse pages are indexable; arbitrary search URLs are `noindex` by
  default.
- Search/list endpoints remain paginated and bounded.
- Existing protected workspace routes still require auth.

## Open Questions

- Should the namespace be `/law/*`, `/legal/*`, or another product term?
- Should AI-generated case analysis ever become public if already generated, or
  always remain an authenticated feature?
- Which browse pages should be curated/indexable in the first release: court
  pages, court/year pages, source pages, topic pages, or only detail pages?
- Should canonical slugs be stored in the database or generated deterministically
  from material metadata at render time?
