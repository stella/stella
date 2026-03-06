# Plan: Case Law Library

Date: 2026-03-06

## Goal

Add a first-class case law library to Stella: ingest court
decisions from multiple jurisdictions (Czech and Slovak courts
first, extensible to any source), provide a premium reading
experience, and connect case law to AI-powered legal research
via the existing chat system.

## Design Decisions

- **Shared global data + tenant-scoped features.** Court
  decisions are public records. Stella ingests them once into
  global tables (no `organizationId`). All authenticated users
  read from the same pool. Tenant-scoped tables handle private
  features: matter links, saved searches, annotations.

- **Reuse existing search infrastructure.** The `SearchProvider`
  pattern (`apps/api/src/lib/search/`) supports pg-fts and
  ParadeDB (BM25). Case law full-text search should integrate
  with this provider pattern: index decisions into
  `search_documents` (or a parallel table following the same
  shape) and query through the same provider interface. This
  avoids building a separate search system and gets us faceted
  search, cursor pagination, and language-aware stemming for
  free.

- **No vector embeddings.** Semantic/vector search is out of
  scope. Full-text search (tsvector / BM25 via ParadeDB) is
  the retrieval mechanism. For AI features (Phase 6), relevant
  decisions are retrieved via full-text search and passed to
  the AI in full.

- **Multi-language from day one.** Segmentation, section
  headings, and citation patterns differ across CZ and SK
  jurisdictions. The segmenter accepts a language parameter
  and dispatches to language-specific pattern sets. Decision
  types and court names are stored as-is (original language);
  the frontend displays them without normalization.

- **Courts reference table with country scoping.** A `courts`
  reference table stores court metadata (name, country, type,
  city). Decisions FK to this table. This enables faceted
  filtering by court type (regional, appellate, supreme) across
  jurisdictions, without relying on free-text court name
  matching. Courts differ across countries; the table is
  country-scoped, not a shared taxonomy.

- **Ingestion is system-operated.** Sources are system-managed,
  not user-configured. Ingestion runs via a background worker
  on a configurable interval (daily max). No source CRUD for
  end users.

- **Citation resolution runs as a post-ingestion pass.** Rather
  than resolving citations on-the-fly during ingestion (which
  would miss cross-source references), a separate pass runs
  after all sources are synced to resolve unlinked citations
  against the full decision corpus.

- **Navigation:** Knowledge > Case Law tab (no sidebar change).

## Data Boundary: Global vs. Tenant-Scoped

### Global tables (no tenant column)

| Table | Contents |
|-------|----------|
| `case_law_courts` | Court reference data (name, country, type) |
| `case_law_sources` | System-managed ingestion source registry |
| `case_law_decisions` | Court decisions (public records) |
| `case_law_citations` | Citation graph between decisions |
| `case_law_search_documents` | FTS index (parallel to `search_documents`, no tenant col) |

Read access: any authenticated user. Write access: system only
(ingestion pipeline, admin scripts).

### Tenant-scoped tables

| Table | Scope | Contents |
|-------|-------|----------|
| `case_law_matter_links` | workspace | Links decisions to matters |
| `case_law_searches` | organization | Saved search sessions (Phase 6) |
| `case_law_search_results` | via searchId FK | AI-extracted answers (Phase 6) |

## Scope

**In scope:**

- DB schema (global + tenant tables, courts reference table)
- Ingestion pipeline with 4 CZ/SK adapters
- Multi-language text segmentation (CZ + SK patterns)
- Citation extraction and post-ingestion resolution
- Full-text search via existing SearchProvider infrastructure
- Decision browser (table with faceted filters)
- Case viewer (3-panel: ToC, text, metadata)
- Matter linking (workspace-scoped)
- Background worker for scheduled ingestion
- AI columnar search (Phase 6) using FTS retrieval + AI

**Out of scope:**

- Vector embeddings / semantic search
- User-configurable ingestion sources
- Jurisdictions beyond CZ/SK (architecture supports them;
  adapters are future work)
- RBAC on case law access (all authenticated users can read)
- Real-time ingestion (daily sync is sufficient)

## Phases

### Phase 1: Database Schema + Core API (done)

Schema, handlers, ingestion pipeline, adapters, routes.
See PR #461.

### Phase 2: Search Integration

Integrate case law decisions with the existing search provider
infrastructure.

**Decided: parallel table (`case_law_search_documents`).**

The existing `search_documents` table has a required
`SafeId<"organization">` column. Mixing global case law
data into a tenant-scoped table would either require faking
an org ID or making the column nullable, both of which break
the type-system tenant-isolation guarantee. Separate tables
keep the global/tenant boundary structurally enforced (no
compensating controls needed for SOC 2 / ISO 27001 audit).

The `case_law_search_documents` table follows the same shape
(decisionId PK, title, searchableText, language, tsv) but
has no organizationId column. The `SearchProvider` interface
is reused: same pg-fts / ParadeDB logic, different table.
A dedicated search endpoint queries the case-law table.

### Phase 3: Frontend — Decision Browser

Decision table with TanStack Table. Faceted filters: court
(via courts reference table, grouped by country and type),
country, date range, decision type. Full-text search input
using the search integration from Phase 2. Cursor-based
infinite scroll.

### Phase 4: Frontend — Case Viewer

Three-panel layout (react-resizable-panels):
- Left: section ToC from `decision.sections`
- Center: rendered fulltext with citation highlighting
- Right: metadata sidebar (court, date, ECLI, legal
  sentence, cited-by / cites lists, "link to matter" button)

Copy-with-citation on text selection.

### Phase 5: Background Worker + Courts Reference

- Background worker for scheduled ingestion (configurable
  interval, daily default). Replaces CLI-only invocation.
- Courts reference table with seed data for CZ/SK courts.
- Migration of existing decisions to FK to courts table.

### Phase 6: Columnar AI Search (Midpage-style)

Saved search sessions (org-scoped). Each session has question
columns. For each decision in the result set:
1. Retrieve relevant sections via full-text search
2. Pass sections to AI with the column question
3. Store extracted answer (yes/no/text + confidence)
4. Yes/No columns are filterable in the grid

Uses existing chat/AI infrastructure (Vercel AI SDK).

### Phase 7: Chat Integration

Add `case_law_search` tool to the chat actor's tool registry.
Uses full-text search to find relevant decisions, returns
excerpts with links to case viewer. Workspace-scoped threads
can search case law in context of a matter.

## Implementation Notes

### Files to Create/Modify (Phase 1 — done)

See PR #461 for the full file list.

### Search Integration (Phase 2) — Key Files

| Action | File |
|--------|------|
| Modify or mirror | `apps/api/src/lib/search/provider.ts` |
| Create | `apps/api/src/handlers/case-law/search-index.ts` |
| Modify | `apps/api/src/handlers/case-law/ingestion/pipeline.ts` |
| Modify | `apps/api/src/handlers/case-law/decisions/search.ts` |

### Courts Reference (Phase 5) — Key Files

| Action | File |
|--------|------|
| Modify | `apps/api/src/db/schema.ts` (add `case_law_courts`) |
| Create | `apps/api/scripts/seed-courts.ts` |
| Modify | `apps/api/src/handlers/case-law/ingestion/pipeline.ts` |

## Verification

### Phase 1 (done)
- `bun run db:push` succeeds
- `bun run typecheck` passes
- Global-read endpoints work with auth
- Tenant-scoped endpoints enforce workspace access

### Phase 2
- Case law decisions appear in search results
- Full-text search returns relevant results ranked by BM25
- Language-aware stemming works for CZ/SK text

### Phase 3
- Decision table renders with faceted filters
- Court filter groups by country and court type
- Infinite scroll loads pages correctly

### Phase 4
- Three-panel case viewer renders
- Section navigation scrolls correctly
- Citations are highlighted and clickable
- Copy-with-citation works

### Phase 5
- Background worker runs ingestion on schedule
- Courts reference table populated with CZ/SK courts
- Court facet filter uses reference data

### Phase 6
- Columnar search: add a question column, AI extracts answers
- Yes/No filtering works on AI-extracted columns

### Phase 7
- Chat actor can search and cite case law
- Results include links to case viewer
