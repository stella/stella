# Codebase Map

Quick-reference for navigating Stella. Read this before
exploring; it saves many tool calls.

## System Overview

```
┌─────────────────┐     ┌─────────────────┐
│   Web App       │────▶│   API Server    │
│   React + Vite  │     │   Elysia + Bun  │
│   Port 3000     │     │   Port 3001     │
└─────────────────┘     └────────┬────────┘
                                 │
                    ┌────────────┼────────────┐
                    │            │            │
               ┌────▼────┐  ┌────▼────┐  ┌────▼────┐
               │Postgres │  │   S3    │  │   AI    │
               │ Drizzle │  │  Files  │  │ Google  │
               └─────────┘  └─────────┘  └─────────┘
```

## Data Model

Core tables in `apps/api/src/db/schema.ts`:

- **workspaces** — matters within an organisation
- **files** — immutable file records (PDFs), tracked by sha256
- **properties** — data extraction rules/templates
- **propertyDependencies** — dependency graph between properties
- **entities** — documents/files/tasks within workspaces
- **fields** — property values for entities (linked to files)
- **justifications** — evidence supporting field values
  (HTML + bounding boxes)

Auth tables in `apps/api/src/db/auth-schema.ts` (better-auth):

- **users**, **sessions**, **accounts**, **verifications**
- **organizations**, **members**, **invitations**

## Key Patterns

- **File flow**: client → presigned URL → S3 direct upload →
  DB record
- **AI flow**: documents → AI SDK (Google) → structured
  extraction → fields + justifications

## Monorepo Layout

```
stella/
├── apps/
│   ├── api/             # Elysia backend (Bun)
│   └── web/             # Vite + React frontend
├── packages/
│   ├── ui/              # 28 shared Base UI components
│   ├── rivet/           # RivetKit actor configs
│   ├── permissions/     # Auth/permission utilities
│   ├── transactional/   # React Email templates
│   ├── scripts/         # i18n CLI tools
│   ├── skills/          # AI skill prompts + knowledge
│   └── typescript-config/
```

## Backend (apps/api/src/)

### Entry Points

- `index.ts` — Elysia app factory; mounts routes, CORS,
  rate limiting, error handling, security headers
- `env.ts` — env var validation
- `types.ts` — derived types (EntityKind, ViewLayout, etc.)
- `consts.ts` — global constants
- `mime-types.ts` — MIME type constants

### Handler Domains (apps/api/src/handlers/)

Each domain has `routes.ts` + individual endpoint files.

**Core data:**

- `workspaces/` — matter CRUD, members, contacts, access
- `entities/` — document/file CRUD, upload, download, move
- `files/` — file processing, PDF utils, Gotenberg
- `properties/` — custom field definitions
- `fields/` — dynamic field schema upsert
- `search/` — full-text search (ParadeDB / PG FTS)

**Billing:**

- `time-entries/` — time tracking, CSV/LEDES/PDF export
- `invoices/` — invoice lifecycle, entries
- `billing-codes/` — billing code tree
- `rates/` — billing rates with date ranges
- `expenses/` — expense tracking

**Knowledge:**

- `templates/` — template library, fill, preview
- `template-analytics/` — usage metrics
- `clauses/` — clause library, vector search
- `docx/` — DOCX diffs, block directives, edits
- `case-law/` — ingestion, polarity, citations

**Other:**

- `contacts/` — contact CRUD
- `tasks/` — task assignment, entity linking
- `chat/` — chat context, file uploads
- `analytics/` — hours/revenue breakdowns
- `verify/` — auth verification, token refresh
- `organization-settings/` — org-level config
- `registry/` — RivetKit workflow orchestration
- `dev/` — dev-only endpoints

### Shared Libraries (apps/api/src/lib/)

**Core infra:**

- `api-handlers.ts` — `createHandler()` for workspace
  mutations with permission checks
- `auth.ts` — better-auth setup, permission macro,
  workspace access macro
- `branded-types.ts` — SafeId, WorkspaceId, etc.
- `invalidate-query-macro.ts` — cache invalidation macro

**Database:**

- `custom-schema.ts` — Elysia schema helpers (tNanoid)
- `entity-filters.ts` — entity query filtering
- `escape-like.ts` — SQL LIKE escaping
- `pg-error.ts` — PostgreSQL error parsing

**Document processing:**

- `document-counter.ts` — document numbering stamps
- `document-reference.ts` — matter reference notation
- `docx-stamp.ts` — DOCX content stamping
- `matter-reference.ts` — matter notation utilities

**File handling:**

- `content-disposition.ts` — HTTP header construction
- `content-encryption.ts` — file encryption/decryption
- `sanitize-filename.ts` — filename sanitization
- `s3.ts` — S3 client

**Subdirectories:**

- `errors/` — TaggedError, HTTPError, structured errors
- `search/` — pluggable search providers (ParadeDB,
  PG FTS), extraction, indexing, language detection
- `file-scan/` — YARA-based malware scanning, ZIP scan
- `rate-limit/` — Redis + Lua rate limiting
- `markdown/` — markdown processing

**Other:**

- `ai-models.ts` — AI provider config
- `posthog.ts` — analytics client
- `redis.ts` — Redis client
- `email.tsx` — email template rendering
- `locale.ts` — localization helpers
- `limits.ts` — rate limit config
- `security-headers.ts` — HTTP security headers
- `subprocess.ts` — child process execution
- `type-guards.ts` — TS type guards
- `views.ts` — view helpers

### Database (apps/api/src/db/)

- `schema.ts` — all Drizzle table definitions
- `auth-schema.ts` — better-auth schema
- `rls.ts` — row-level security policies
- `schema-validators.ts` — Zod validators for schema
- `billing-validators.ts` — billing validators
- `json-utils.ts` — JSON column utilities
- `index.ts` — DB client init

### Tests (apps/api/src/tests/)

- `security/` — RLS tests (positive, negative, coverage,
  scoped-db), branded-type safety tests

## Frontend (apps/web/src/)

### Route Structure (apps/web/src/routes/)

TanStack Router file-based routing.

- `__root.tsx` — app shell, auth check
- `_protected.tsx` — auth guard

**Route groups:**

- `auth/` — login, OTP, org creation, invitation
- `_protected.account/` — user settings, sessions
- `_protected.organization/` — members, invitations
- `_protected.workspaces/` — **main feature hub** (below)
- `_protected.knowledge/` — templates, clauses, case law
- `_protected.chat/` — global chat threads
- `_protected.calendar/` — calendar view
- `_protected.contacts/` — contact directory
- `_protected.todos/` — todos + calendar
- `_protected.dev/` — dev tools

### Workspace Routes (the big one)

`routes/_protected.workspaces/$workspaceId/`

**Pages:**

- `index` — workspace overview
- `$viewId.index` — table/kanban views
- `$viewId.pdf` — PDF viewer with annotations
- `timesheets` — timesheet week/day view
- `expenses` — expense list
- `invoices/` — invoice list + `$invoiceId` detail
- `analytics` — workspace analytics

**Colocated structure:**

```
$workspaceId/
├── -components/        # 70+ workspace UI components
│   ├── analytics/      # charts, summaries
│   ├── billing/        # time, expenses, invoicing
│   ├── calendar/       # calendar views
│   ├── tasks/          # task detail, subtasks
│   ├── kanban/         # kanban cards, columns
│   ├── table/          # table layout, cells
│   ├── properties/     # property forms, inputs
│   ├── pdf/            # PDF viewer, pages
│   ├── inspector/      # side panel entity detail
│   ├── filesystem/     # document tree
│   ├── peek/           # quick preview
│   └── view/           # view switcher, filters
├── -hooks/             # 11 workspace-specific hooks
├── -mutations/         # 9 mutation domains
├── -queries/           # 13 query domains
├── -utils.ts           # workspace utilities
└── -party-roles.ts     # legal party role constants
```

### Zustand Stores (9 total)

| Store           | Location                                       | Purpose                               |
| --------------- | ---------------------------------------------- | ------------------------------------- |
| workspace store | `$workspaceId/-store.tsx`                      | view mode, filters, selected entities |
| table store     | `$workspaceId/-hooks/table-store.ts`           | pagination, sorting                   |
| inspector store | `-components/inspector/inspector-store.ts`     | selected entity, tab                  |
| template store  | `knowledge/-store/template-assistant-store.ts` | template wizard state                 |
| chat panel      | `lib/chat-panel-store.ts`                      | right panel open/closed, thread       |
| pinned          | `lib/pinned-store.ts`                          | sidebar favorites                     |
| i18n            | `i18n/i18n-store.ts`                           | language selection                    |
| dev             | `lib/dev-store.ts`                             | dev mode toggles                      |
| pdf             | `lib/pdf/pdf-store.ts`                         | page, zoom, annotations               |

### Shared Components (apps/web/src/components/)

- `app-sidebar.tsx`, `sidebar.tsx` — main navigation
- `right-panel-chat.tsx` — matter-scoped AI chat
- `search-dialog.tsx` — global search
- `theme-provider.tsx` — theme management
- `feedback-dialog.tsx` — user feedback
- `ai-elements/` — chat message rendering
- `breadcrumbs/` — per-context breadcrumbs
- `chat/` — tool call cards, sources, attachments

### Global Hooks (apps/web/src/hooks/)

- `use-permissions.ts` — RBAC checks
- `use-invalidate-session.ts` — session refresh
- `use-sign-out.ts` — sign-out handler
- `use-sync-queries.ts` — cross-tab query sync

### Lib (apps/web/src/lib/)

- `api.ts` — Eden client initialization
- `auth.ts` — auth state/sessions
- `consts.ts` — app constants
- `hotkeys.ts` — keyboard shortcuts
- `utils.ts` — common utilities
- `schema.ts` — shared validators
- `ai-sdk/` — Rivet transport adapter
- `anonymize/` — NER + redaction pipeline (23 files)
- `errors/` — error utilities
- `pdf/` — PDF viewer utilities, store
- `posthog/` — analytics helpers

### i18n (apps/web/src/i18n/)

11 languages: cs, de, en, es, et, fr, hu, lt, lv, pl, sk.
Source language: en. Runtime: `use-intl`.

## Packages

| Package                     | Purpose                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `@stella/ui`                | 28 Base UI components (button, input, dialog, table, etc.)             |
| `@stella/rivet`             | RivetKit actor configs (workflow, chat, views, bbox, sync)             |
| `@stella/permissions`       | Permission/auth utilities                                              |
| `@stella/transactional`     | Email templates (OTP, invitations)                                     |
| `@stella/scripts`           | i18n CLI (check + typegen)                                             |
| `@stella/skills`            | AI skill prompts: case briefing, legal interpretation, GDPR, contracts |
| `@stella/typescript-config` | Shared strict TS configs                                               |
