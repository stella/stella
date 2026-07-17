# Plan: Legal Lists

Date: 2026-07-17

## Goal

Build a first-class, matter-scoped Lists workflow that turns source documents
into structured, attributable legal work: customizable rows, assignments,
document and clause sources, AI-generated drafts, controlled review, sign-off,
and a complete activity trail.

## Design Decisions

- **A List is a domain resource, not a saved view**: the List owns its name,
  lifecycle, sections, columns, and items; saved table and board views remain
  presentation settings over that resource.
- **List items remain entities**: tasks, facts, issues, requirements, and events
  stay compatible with search, mentions, agenda, assignments, entity links,
  custom fields, exports, and agents without pretending to be documents.
- **Sources are immutable references**: provenance records the source entity and
  entity version plus a typed DOCX-block or PDF-page locator, quoted text, and
  verification state. A later document version cannot silently change prior
  evidence.
- **AI produces reviewable candidates**: generation does not mutate a live List
  directly. Users review, edit, accept, or reject bounded draft candidates with
  citations before insertion.
- **Audit and sign-off are separate concerns**: the existing append-only audit
  trail records every mutation; explicit review records capture legal
  verification and sign-off semantics.
- **Public workflows are the boundary**: implement externally documented legal
  tracker workflows without inferring private or undisclosed behavior.

## Scope

**In scope:**

- Matter-scoped Lists with active and archived lifecycle states.
- Sections/workstreams, stable row ordering, and List-specific columns.
- Task, fact, issue, requirement, and event items.
- Status, priority, due date, assignees, custom fields, and entity links.
- Multiple source documents per row with clause- or page-level provenance.
- Source preview navigation and verification state.
- AI generation from selected matter documents into draft candidates.
- Candidate review, editing, partial acceptance, rejection, and retry.
- Row-level activity, comments, review, and sign-off history.
- Table and board views, filters, sorting, grouping, exports, and reports.
- Reusable legal List templates for closing, chronology, issues, obligations,
  and due-diligence tracking.
- Complete typed HTTP, MCP, and agent access.
- Backwards-compatible migration of existing Todos/tasks.
- Internationalized and RTL-safe web UI.

**Out of scope:**

- Copying another product's undisclosed behavior or visual trade dress.
- External counterparty portals and cross-organization sharing.
- Replacing Tabular Review; Lists consume findings and track legal work, while
  Tabular Review remains the document-by-document extraction surface.
- Removing legacy task columns during the additive migration window.
- A new global Home screen; its future assigned-items feed will consume the
  first-class Lists API.

## Implementation

- `apps/api/src/db/schema/lists.ts` and `apps/api/src/db/schema/entities.ts` —
  List containers, sections, column membership, item membership, immutable
  sources, generation runs/candidates, comments, and reviews; all
  workspace-scoped with composite ownership constraints and bounded-query
  indexes.
- `apps/api/drizzle/` — additive migration that creates List resources, keeps
  legacy tasks readable, and supports a bounded backfill/default-List rollout.
- `apps/api/src/handlers/lists/` — cursor-paginated CRUD, sections, columns,
  items, sources, activity, comments, review/sign-off, generation, candidate
  review, and commit handlers using safe workspace authorization.
- `apps/api/src/lib/lists/` — shared validation, provenance locators, state
  transitions, ordering, generation contracts, and backwards-compatible task
  adapters used by HTTP and agent entry points.
- `apps/api/src/lib/workflow/` — reuse the provider-neutral extraction and
  justification pipeline for candidate generation and typed source anchors.
- `apps/api/src/mcp/` — List-oriented tools for reading, generating, reviewing,
  and updating Lists; retain task aliases during compatibility rollout.
- `apps/web/src/routes/_protected.workspaces/$workspaceId/` — List route and
  loaders, source-selection/generation flow, review queue, activity drawer,
  source preview, sections, table/board controls, and accessible loading states.
- `apps/web/src/i18n/` — natural translations for every supported language,
  generated message types, and RTL/bidirectional coverage.
- Existing view, property, report, and export slices — scope queries to a List
  resource while preserving generic view behavior.

## Test Cases

- Workspace A cannot read, mutate, generate from, or cite resources in
  workspace B; forged entity, version, section, property, assignee, and source
  IDs fail closed.
- List and item list endpoints are cursor-paginated and deterministic under
  concurrent inserts.
- Legacy tasks remain visible and migrate into exactly one default List without
  duplicate items or lost metadata.
- Sections and item ordering remain stable across moves and concurrent edits.
- A source always belongs to the same workspace, references the selected
  immutable entity version, and validates its typed locator.
- Generation creates no live items before acceptance; accepting a subset is
  atomic and idempotent, and retries cannot duplicate rows.
- Every mutation emits an audit event; review and sign-off history is
  append-only and identifies the actor and timestamp.
- Exports neutralize spreadsheet formulas and include visible List columns,
  sections, assignees, and source references.
- HTTP and MCP paths enforce identical validation and authorization.
- Table, board, generation review, keyboard navigation, source opening, empty
  states, responsive layouts, and Arabic RTL behavior pass browser coverage.
