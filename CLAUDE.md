# Stella Development Guidelines

## Learning & Preserving Patterns

When you discover important patterns during our conversation (e.g., naming
conventions, architectural decisions, preferred approaches, project-specific
quirks), ask the user if it should be saved to the relevant CLAUDE.md file.

## Ideal Customer Profile (ICP)

**Current focus: mid-size law firms, 5–50 lawyers.**
Pragmatic, cost-conscious, not overly technical. They care about:
reliability, data sovereignty, clear pricing, and not being locked in.

**Scale target: Magic Circle firms (2,000–5,000+ lawyers).**
The architecture must not block scaling to this level. See the
Scalability section below for decision guidelines.

International audience: do not assume English language or English
typography conventions are universal. Highlight competing standards
(date formats, quotation marks, citation styles, legal terminology)
when relevant.

## Project Overview

Stella is an open-source legal workspace. Core DMS features (matters,
documents, search) are free forever. AI-powered features (review,
research) are paid by usage.

**Monorepo structure:**

```
stella/
├── apps/
│   ├── api/          # Elysia backend (Bun runtime)
│   └── web/          # Vite + React frontend
├── packages/
│   ├── rivet/        # Rivet config and integration
│   ├── ui/           # Shared UI components
│   ├── prettier-config/
│   └── typescript-config/
```

## Commands

```bash
bun run dev              # Start all dev servers
bun run dev:web          # Web only (port 3000)
bun run dev:api          # API only (port 3001)
bun run build            # Build all packages
bun run lint             # Lint (Biome)
bun run format           # Format (Prettier)
bun run typecheck        # TypeScript check
bun run test             # Run tests (Bun)
bun run db:push          # Push DB schema changes
```

## Documentation Access

The `stella-docs` MCP server provides on-demand access to
library documentation via `llms.txt`. When implementing features,
fetch the relevant docs first using `list_doc_sources` and
`fetch_docs` tools.

**Covered libraries:** Elysia, Drizzle, TanStack (Router, Query,
Form, Table), React, Valibot, Zod, TipTap, Bun, better-auth,
PostHog, Zustand.

**Not covered (no `llms.txt`):** Tailwind CSS, Biome.
For these, use `WebFetch` or `WebSearch` directly.

**Setup:** run `bun run setup:mcp` once after cloning.

## Tech Stack

| Layer               | Technology                           |
| ------------------- | ------------------------------------ |
| Runtime             | Bun                                  |
| Package manager     | Bun (workspaces)                     |
| Build orchestration | Turbo                                |
| Frontend            | React 19, Vite, TailwindCSS 4        |
| Routing             | TanStack Router                      |
| State (server)      | TanStack React Query                 |
| State (client)      | Zustand                              |
| Forms               | TanStack React Form                  |
| Tables              | TanStack React Table                 |
| Backend             | Elysia                               |
| Database            | PostgreSQL + Drizzle ORM             |
| Auth                | better-auth                          |
| Storage             | S3                                   |
| AI                  | Vercel AI SDK + Google Generative AI |
| Validation (API)    | Zod                                  |
| Validation (Web)    | Valibot                              |
| Analytics           | PostHog                              |
| Linting             | Biome (ultracite preset)             |
| Formatting          | Prettier                             |
| PDF                 | pdfjs-dist, @libpdf/core             |
| UI components       | coss (Base UI)                       |
| Rich text           | TipTap                               |
| Workflows           | RivetKit                             |

## Meta Preferences

- Line length: max 88 characters for code and documentation (if
  possible)
- Never reformat code you did not semantically change. If a line
  or block was not modified for the task at hand, leave its
  formatting, comments, and whitespace exactly as they were.
- Vary punctuation: prefer colons, semicolons, commas, and parentheses
  over em dashes. Do not overuse any single punctuation pattern.
- Keep comments concise
- Prefer explicit over implicit — when a backend endpoint
  accepts a discriminator (e.g., `?type=document|file`),
  thread it through the full stack (URL params, component
  props) instead of hardcoding a default on the frontend
- TypeScript strict mode throughout
- If TypeScript can make a class of bug structurally
  impossible (branded types, discriminated unions, exhaustive
  checks), prefer that over runtime validation or manual
  discipline. This applies equally to security boundaries
  (e.g., `SafeId`, tenant-scoped types) and business logic.
- "One obvious way" — consistent patterns across the codebase
- Conventional Commits: `feat:`, `chore:`, `fix:`, `docs:`
- Rebase feature branches onto main instead of merging. This
  keeps history linear and avoids noisy merge commits in PRs.
- Errors should never pass silently
- Fail fast — validate at boundaries, return/throw early
- Minimize brace nesting — invert conditions, use early
  returns, and check specific cases before general ones to
  keep code flat
- Don't compare against string literals that represent domain
  values (MIME types, status codes, etc.). Use named constants.
- Code is read 10x more than written. Write for the reader.
- No `eval()`, no direct `document.cookie` assignment
- Avoid spread syntax in accumulators inside loops (use
  `.push()` or pre-allocated arrays instead)
- Security is extremely important given the volume and nature of
  data we handle.
- If you encounter a pre-existing bug or lint error while
  working on something else, investigate and confirm it, then
  fix it (in a separate commit). Don't leave known defects
  behind.

## Regulated Industry

Stella handles privileged legal data (attorney-client privilege,
litigation holds, personal data). All code must be written as if we
are operating under **SOC 2 Type II** and **ISO 27001** controls.

Principles derived from these standards that apply to every change:

- **Least privilege** — services, users, and tokens get the minimum
  permissions needed. No wildcard IAM policies, no admin-by-default.
- **Audit trail** — state-changing operations must be traceable to
  an actor and timestamp. Never silently mutate data.
- **Encryption in transit and at rest** — TLS everywhere, S3 SSE,
  no plaintext secrets in code or logs.
- **Input validation at boundaries** — all external input (user,
  API, file upload) is validated and sanitised before processing.
- **Separation of concerns** — workspace isolation is mandatory.
  Data from one workspace must never leak to another.
- **Access control** — every endpoint must enforce auth and
  authorisation. No "internal-only" endpoints without guards.
- **Dependency hygiene** — keep dependencies minimal, pinned, and
  audited.
- **Logging without leaking** — log enough to investigate incidents,
  never log secrets, tokens, PII, or document contents.
- **Change management** — all changes go through PR review. No
  direct commits to main.
- **Data retention** — respect deletion requests. When data is
  deleted, it is actually deleted (not soft-deleted indefinitely).

## Design Principles

### Clarity, not magic.

Every part of Stella should be understandable: how it works, what it
costs, why it does what it does. No hidden complexity. If a user or
contributor cannot understand a feature by reading the code, that might
be considered a bug.

### Built to last.

Every operation (opening a matter, searching documents, reviewing
documents) can be performed by a person, a script, or by an AI agent.

### Your practice, your data.

No lock-in. Standard file formats. Easy export. Self-hosting is a
first-class option, not an afterthought.

### Responsible by design.

The legal profession has ethical obligations that predate software by
centuries. We design around them from the start. AI outputs are
grounded by citations and traceable to source material.

### AI is a tool, not a persona.

Do not anthropomorphize AI with names or personas
("I am Stella, your assistant"). Be honest about
AI capabilities.

### Performance is non-negotiable.

This is a professional tool. Every interaction should feel fast.
Batch operations, minimize round-trips, lazy-load aggressively.

### Vertical slices over horizontal layers.

Structure features as independent end-to-end slices (own
routes, components, handlers) rather than editing shared
horizontal layers. This minimizes merge conflicts when multiple
people work in parallel: PDF rendering lives under its own
route, so improving it never touches the table view; DOCX
templates get their own routes behind a feature flag, reading
workspace data but rendered in complete isolation.

Vertical slices also serve as an isolation boundary for
AI-generated exploratory features. New capabilities land in
their own slice with limited scope, keeping existing clean code
untouched. When the experiment concludes, the slice is either
rewritten properly or removed entirely; neither operation
requires surgery on unrelated code.

## Scalability

**Principle: never paint yourself into a corner.**

Stella's current focus is mid-size firms, but the architecture must
support Magic Circle scale (2,000–5,000+ lawyers, millions of
documents, global offices) without a rewrite. Apply this rule of
thumb to every design decision:

- If the scalable solution costs roughly the same effort as the
  simple one, choose the scalable solution now.
- If real scalability requires significantly more work, the
  simple solution is fine, but it must be _replaceable_ without
  restructuring surrounding code. Isolate it behind an interface,
  a config flag, or a clean module boundary.

### What this means in practice

**Pagination and streaming.** Never return unbounded result sets.
Every list endpoint must accept `limit`/`cursor` (or
`limit`/`offset`). Even if the UI does not paginate today, the
API must support it so the frontend can adopt pagination or
virtual scrolling independently. For file processing, prefer
streaming over loading entire files into memory.

**Tenant isolation.** Application-level filtering (via `SafeId`
and `workspaceAccessMacro`) is the current approach. Do not
introduce patterns that would prevent adding PostgreSQL
Row-Level Security (RLS) later: always filter by tenant ID in
the query itself, never fetch-then-check in application code.

**Stateless API processes.** Keep the Elysia server stateless so
it can run behind a load balancer with N replicas. No in-process
singletons that hold mutable state (caches, queues, locks).
Background work should be delegable to a separate worker or
queue consumer.

**Resource limits as configuration.** Limits (entity count,
property count, file size) must never be magic numbers scattered
in handlers. Define them in `lib/limits.ts` and design the
schema so they can become per-plan or per-organization settings
without code changes.

**AI provider abstraction.** Do not hardcode a single AI
provider in business logic. The provider should be selectable
via configuration so that failover, multi-provider, or
self-hosted models can be added without rewriting workflow
actors.

**Indexes.** When adding a column that will be used in `WHERE`,
`ORDER BY`, or `JOIN`, add an index in the same migration.
Composite indexes should lead with the tenant-scoping column
(`workspaceId`, `organizationId`). Justify _omitting_ an index,
not adding one.

**Connection pooling.** Assume the database connection pool is a
shared, finite resource. Avoid long-held transactions; keep
transactions as short as possible. Design for an external pooler
(PgBouncer) sitting between the app and PostgreSQL.

### Known scale gaps (acceptable today, tracked for later)

These exist, are known, and do not need fixing right now; but
new code must not make them worse:

- No session caching (session lookups hit DB every request;
  Redis is available for rate limiting but not yet used as a
  general cache)
- No granular RBAC (auth and workspace-level access control are
  enforced; role-based permissions within a workspace are not)
- Frontend entity table has no virtualization or server pagination
- Random nanoid PKs (B-tree insert fragmentation at scale;
  prefer time-ordered IDs like ULIDs for new high-volume tables)

## Brand & Visual Identity

Keywords: **crystal-clear, subtle, detail-oriented, high-precision.**

Visual inspiration: glass-like surfaces. Clean, translucent, precise.

The default palette is clean neutral grays on white. Accent palettes
(Nord, Flexoki) are available as user preferences; the brand itself
stays monochrome with the Stella § mark.

Colours from the brand deck (for reference, not for hard-coding):

| Name        | Hex       | Usage                          |
| ----------- | --------- | ------------------------------ |
| Black       | `#000`    | Primary text, logo mark        |
| Soft Blue   | `#cae1fb` | Illustration/accent background |
| Pale Blue   | `#e2f6fd` | Light tint surfaces            |
| Blue Accent | `#59a1d4` | Accent in marketing material   |

In the product UI, use semantic tokens (`bg-muted`, `text-foreground`,
`border`) rather than raw colour values. The palette CSS variables
handle light/dark/palette switching automatically.

## UX Philosophy

**Core beliefs:**

- Users notice the little things.
- Every interaction should feel smooth.
- Good UX is invisible; it just works.
- Keep users focused and in the flow: minimum clutter.

**Micro-interactions that delight:**

Small, almost invisible touches that make the experience feel
premium. Linear is a good reference.

- Number/count transitions: subtle fade (~200ms). No flashy
  slot-machine animations; this is a professional tool.
- State transitions (loading, success, error) should feel
  continuous, not jarring.
- Keep it subtle. The goal is "oh, that's nice", not "look at that
  animation". When in doubt, simpler is better, or skip it.

**Reduce visual noise:**

- Secondary information (counts, metadata) should be subtle by
  default. Use opacity transitions to reveal details on hover.
- Don't compete for attention; let the content speak.

## Coding Conventions

### TypeScript

- Prefer `type` over `interface`
- No enums — use `as const` objects or union types
- No `any` — use `unknown` and narrow
- No non-null assertions (`!`) — restructure to check for null
- No type casts (`as`) — restructure to narrow properly (type
  guards, `in` checks, records instead of arrays). If truly
  unavoidable, ask before adding and include a `// SAFETY:`
  comment explaining why the cast is sound.
- When a type mismatch appears, trace it to the source (e.g.,
  the handler or query that produces the wrong type) rather
  than casting at the consumer. Check git to verify you didn't
  introduce the mismatch yourself before blaming the framework.
- Use `import type` for type-only imports
- Prefer arrow functions over function expressions
- Destructure in the parameter when the intermediate variable
  is not reused (e.g., `{ body: { file, name } }` not
  `body` then `const { file, name } = body`)
- Use `.at(0)` when the element may not exist. Use `[0]` only
  when existence is already established (length check, or a
  `// SAFETY:` comment explaining why).
- Prefer discriminated union narrowing (`obj.type === "x"`)
  over `"key" in obj` checks. Use `in` only when the type is
  not a discriminated union and there is no discriminator to
  check.

### React

- Zustand with `useShallow()` for multi-slice selectors
- Skip barrel files (`index.ts`) — import from explicit paths
- Use coss (Base UI) components — registered as `@coss` in
  `components.json`. Prefer coss primitives over hand-rolling.
- Use semantic HTML elements (`<button>`, `<nav>`, `<main>`)
  over generic `<div>`s with ARIA roles. Provide meaningful
  `alt` text for images, proper heading hierarchy, labels for
  form inputs, and keyboard event handlers alongside mouse
  events.
- Tailwind for styling — stay within configured palette
- `cn()` utility for conditional class names
- Return minimal data from endpoints and mutations. Backend
  handlers should only return what callers actually need;
  frontend response types should only type what they consume.
  Don't speculatively return extra fields "for completeness."
- Don't create single-use mutation hooks just to wrap an API
  call. Inline the API call at the usage site and use
  `Result.tryPromise` for retries instead of React Query's
  `retry` on throwaway mutations.
- Reuse existing components (`Button`, `Input`, etc.) with
  `className` overrides instead of writing inline `<button>`,
  `<input>`, or similar raw HTML elements. This keeps behaviour
  (focus rings, accessibility, sizing) consistent across the app.
- Prefer `useRouteContext` for data already provided by parent
  route loaders (`beforeLoad`) over firing a separate query.
  Extend the route context if needed rather than adding a query.
- Use `useDebouncedCallback` from `use-debounce` instead of
  hand-rolling debounce with `useRef<setTimeout>` + manual
  `clearTimeout`. The library handles cleanup automatically.

### Backend (Elysia)

- All handlers in `/apps/api/src/handlers/`
- Don't export types that have no consumer. Elysia infers
  handler types via Eden; manually exporting schema types is
  unnecessary unless explicitly imported elsewhere.
- Prefer Bun-native APIs over Web Crypto or manual
  implementations (e.g., `Bun.CryptoHasher`, `Bun.file`,
  `Bun.S3Client`). This is a Bun runtime; don't write
  browser-compatible code on the backend.
- Drizzle ORM for all database access — no raw SQL unless
  absolutely necessary
- Don't use `?.` or `?? []` to silently handle relations that are
  structural invariants of the data model (e.g. `entity.currentVersion`
  always exists after creation). Use `panic()` instead so violations
  are caught immediately rather than silently returning corrupt data.
- Prefer Drizzle's relational query API (`db.query.*.findFirst`,
  `findMany`) over SQL-like syntax (`select().from().where()`).
  Use SQL-like syntax only for queries that genuinely benefit
  from it (cross-table filtering, aggregations, unions).
- Timeouts on all external calls:
  ```typescript
  fetch(url, { signal: AbortSignal.timeout(10_000) });
  ```
- Validate inputs at the boundary with Valibot or Elysia schemas
- Before writing manual validation, check if the schema/type
  system already provides a declarative constraint (e.g.,
  `t.File({ maxSize })`, `t.String({ maxLength })`). Prefer
  declarative validation over imperative checks.
- Use built-in format validators instead of hand-writing regex
  for standard formats. TypeBox: `format: "date"`,
  `format: "date-time"`, etc. Valibot: `v.isoDate()`,
  `v.isoDateTime()`, `v.email()`, etc.
- Don't add fallback values for properties that the framework
  already guarantees (e.g., `file.type || "..."` when Elysia's
  `t.File()` always provides a type). Trust internal code and
  framework guarantees; only add defensive fallbacks at true
  system boundaries (external APIs, user-controlled input).
- **Ownership IDs are never client-supplied.** Any ID that
  controls data ownership or scoping (`workspaceId`,
  `organizationId`) must come from a server-validated source
  (`SafeId` from `validateWorkspaceAccess`, or
  `ctx.session.activeOrganizationId`), never from the request
  body or query params. Before writing a new handler, read an
  existing handler with the same scope (e.g., another
  workspace-scoped endpoint) to follow the established pattern.

### Error Handling

- Use `better-result` for typed error handling. Do not use
  try-catch for control flow; wrap failable operations with
  `Result` instead. Try-catch is only acceptable at boundary
  layers (top-level request handlers, framework hooks).
- Every `TaggedError` must include a `message: string` field
  for logging and debugging.
- All errors must be surfaced to the user (toast) or propagated
  to the caller
- Capture errors before throwing (PostHog)
- Never swallow errors silently
- Prefer tagged errors (`APIError`, `TaggedError` subclasses)
  over bare `new Error()`. Tagged errors carry structured
  context (status, cause) for error handling and reporting.

### Database

- Schema lives in `/apps/api/src/db/schema.ts`
- Use Drizzle migrations (`bun run db:push`)
- Cascade deletes for workspace-owned resources
- Restrict deletes for file references (prevent orphaning)
- When writing multi-delete transactions, trace the FK graph
  from `schema.ts` and delete in dependency order: delete the
  parent with cascade FKs first (removing referencing rows),
  then delete restrict-FK targets last.
- JSONB columns for flexible content schemas
- Every new list query must support `limit` and a cursor or
  offset. Never return an unbounded `findMany` without a limit.
- Add indexes for any column used in `WHERE`, `ORDER BY`, or
  `JOIN`. Lead composite indexes with the tenant-scoping column.
- Keep transactions short: do I/O (S3, external APIs) outside
  the transaction, not inside.
- Don't filter on unindexed JSONB fields in `WHERE` clauses.
  Fetch by an indexed column, then validate the JSONB content
  in application code. Narrow the discriminated union with a
  type guard instead of using `as` casts.

### Testing

**Only test what can actually go wrong.** A test earns its
place by catching a bug that the type system, framework, or
linter would miss. Don't test identity functions, ORM round-
trips, or that a component renders without crashing.

**Test when code has:** parsing/transformation logic, security
boundaries, business rules with arithmetic, state machines,
non-obvious edge cases. **Skip:** simple CRUD handlers,
library wrappers, layout components, constants.

**Structure:** colocate `foo.test.ts` next to `foo.ts`. For
frontend, extract logic into `foo.logic.ts` and test that
(no React/DOM needed). Structural invariant tests (auth
enforcement, branded types) live in `apps/api/src/tests/security/`.

**Rules:** `bun:test` only. Describe by behaviour, not by
function name. No `beforeEach` / shared mutable state. Prefer
plain fakes over mocking libraries for simple cases; use mocks
when simulating failure modes, testing varied edge-case inputs,
or isolating external services. Every bug fix gets a regression test.

## Internationalization (i18n)

**Stack:** `use-intl` for runtime.

**Supported languages:** en (source), cs, de, hu, pl, sk.

**Translation flow:**

1. Add or modify keys in
   `apps/web/src/i18n/langs/en.json`.
2. Add corresponding translations to all target language
   files (`cs.json`, `de.json`, `hu.json`, `pl.json`,
   `sk.json`). Write natural, idiomatic translations;
   avoid literal/robotic phrasing.
3. Run `i18n-typegen src/i18n/langs` (from `apps/web`) to
   regenerate type declarations (also runs automatically
   before `bun run typecheck`).

**Prefer generic, reusable keys over feature-specific ones.**
Before adding any new i18n key, search `en.json` for an existing
key with the same or similar wording (e.g., `common.filter`,
`common.sort`, `common.columns`). Reuse `common.*` or shared
namespace keys instead of creating feature-scoped duplicates
like `billing.expenses.deleteExpense`. Feature-specific keys
are only justified when the wording truly differs from the
generic version (e.g., a confirmation message that mentions
the resource by name). This keeps the translation file compact
and reduces translator workload.

Key naming, pluralization, and style rules are documented
in `apps/web/src/i18n/TERMINOLOGY.md`.

## GitHub Interactions

- When commenting on GitHub (PRs, issues), include
  "CC on behalf of @username" where username is the GitHub handle
  of the person who requested the comment.

## Linting and Formatting

Biome handles linting via the **ultracite** preset
(`ultracite/core` + `ultracite/react`). Prettier handles
formatting. Together they auto-enforce: `for...of` over
`.forEach()`, `const` over `let`, template literals, no floating
promises, React hooks rules, `key` props on iterables,
`rel="noopener"` on `target="_blank"`, no secrets in source, no
import cycles. If Biome catches it, trust the linter; don't
duplicate the check in code review.

Run before committing:

```bash
bun run lint && bun run format
```

Biome config: `/biome.jsonc`
Prettier config: `/packages/prettier-config/index.mjs`

Import order (enforced by Prettier plugin):

1. React
2. Third-party packages
3. `@stella/*` workspace packages
4. `@/*` path aliases
5. Relative imports
