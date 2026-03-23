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

**Monorepo structure:** see [CODEBASE.md](./CODEBASE.md) for
the full codebase map (handler domains, route structure,
stores, shared libs). Summary:

```
stella/
├── apps/
│   ├── api/          # Elysia backend (Bun runtime)
│   └── web/          # Vite + React frontend
├── packages/
│   ├── ui/           # 28 shared Base UI components
│   ├── rivet/        # RivetKit actor configs
│   ├── permissions/  # Auth/permission utilities
│   ├── transactional/# Email templates
│   ├── scripts/      # i18n CLI tools
│   ├── skills/       # AI skill prompts + knowledge
│   └── typescript-config/
```

## Commands

```bash
bun run dev              # Start all dev servers
bun run dev:web          # Web only (port 3000)
bun run dev:api          # API only (port 3001)
bun run build            # Build all packages
bun run lint             # Lint (oxlint)
bun run format           # Format (oxfmt)
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
PostHog, Zustand, Oxlint.

**Not covered (no `llms.txt`):** Tailwind CSS, oxfmt.
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
| Linting             | oxlint (ultracite preset)            |
| Formatting          | oxfmt                                |
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
- Always choose the most robust, maintainable, and simple
  solution. Never take shortcuts for speed; "quick fix" and
  "fast path" are not acceptable trade-offs.
- If you encounter a pre-existing bug or lint error while
  working on something else, investigate and confirm it, then
  fix it (in a separate commit). Don't leave known defects
  behind.

## Regulated Industry

Stella handles privileged legal data. All code must meet **SOC 2
Type II** and **ISO 27001** standards: least privilege, audit
trails, encryption, workspace isolation, ethical walls. Full
checklist in `/conventions-security`.

## Design Principles

- **Clarity, not magic.** No hidden complexity; code is the docs.
- **Built to last.** Every operation works for humans, scripts,
  and AI agents.
- **Your practice, your data.** No lock-in; standard formats;
  self-hosting is first-class.
- **Responsible by design.** AI outputs grounded by citations.
- **AI is a tool, not a persona.** No anthropomorphizing.
- **Performance is non-negotiable.** Batch operations, minimize
  round-trips, lazy-load aggressively.
- **Vertical slices over horizontal layers.** Features are
  independent end-to-end slices (own routes, components,
  handlers). New capabilities land in their own slice; existing
  code stays untouched.

## Scalability

Never paint yourself into a corner. Architecture must support
Magic Circle scale without a rewrite. Never return unbounded
result sets; keep the API stateless; filter by tenant ID in the
query. Full guidelines in `/conventions-scale`.

## UX & Brand

Use semantic tokens (`bg-muted`, `text-foreground`, `border`),
not raw colour values. Full brand deck, micro-interaction
guidelines, and visual noise rules in `/conventions-ux`.

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
- For functions with multiple numeric (or otherwise
  interchangeable) params, prefer object args over positional
  params to avoid silent bugs from swapped arguments.
- Reuse util types from libraries instead of hand-rolling
  (e.g., `React.PropsWithChildren<P>` for props with children,
  `React.ComponentProps<"button">` for HTML element props).
  Check React, TanStack, and other deps before defining custom
  equivalents.

### React

- Put the root/exported component at the top of the file (after
  imports); helper components and types follow below.
- Prefer `if` statements over nested ternaries for conditional
  rendering. Extract complex logic into a small component that
  returns early with `if` branches instead of chaining ternaries.
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
- Never construct Tailwind class names dynamically
  (e.g. `` `bg-${color}-200` ``); Tailwind can't detect
  them. Use `style` with CSS variables instead
  (e.g. `` style={{ backgroundColor: `var(--color-${name}-200)` }} ``).
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
- Always use `select` with `useParams`, `useSearch`, and
  `useRouteContext` to subscribe only to the fields the
  component needs. Without `select`, the component rerenders
  on any param/search/context change.
- Use `useDebouncedCallback` from `use-debounce` instead of
  hand-rolling debounce with `useRef<setTimeout>` + manual
  `clearTimeout`. The library handles cleanup automatically.
- Query option file ordering: key type → key helpers →
  input type (`QueryOptionsInput`) → option factory →
  hook (e.g., `useEntitiesOptions`).
- Query option factories that use `QueryOptionsInput` with a
  `TContext` must: define a named type alias matching the
  factory name (e.g., `ViewsOptionsInput` for `viewsOptions`,
  `ChatThreadOptionsInput` for `chatThreadOptions`),
  destructure `{ key, context }` in the parameter, and
  reference `key.*` / `context.*` directly in the body (no
  further destructuring). This makes it obvious at the call
  site and inside the function which values drive the cache
  key vs. which are runtime-only deps.
- Define a separate key type (e.g., `EntitiesPageKey`) and
  use it in both the `QueryOptionsInput` and the key helper.
  The key helper's parameter type must be the key type, not
  the full options input, so the key builder only accepts
  cache-identity fields.
- Never spread input objects into query keys. Explicitly
  destructure and reconstruct the key object so extra
  properties from callers cannot leak into the cache
  identity and cause spurious refetches.
- Key helpers must compose by spreading the parent key
  (e.g., `...entitiesKeys.all(workspaceId)`), never by
  duplicating the parent's array literal. This ensures
  changes to the parent key shape propagate automatically.

### Backend (Elysia)

- All handlers in `/apps/api/src/handlers/`
- Don't export types that have no consumer. Elysia infers
  handler types via Eden; manually exporting schema types is
  unnecessary unless explicitly imported elsewhere.
- Prefer Bun-native APIs over Web Crypto or manual
  implementations (e.g., `Bun.CryptoHasher`, `Bun.file`,
  `Bun.S3Client`). This is a Bun runtime; don't write
  browser-compatible code on the backend.
- Drizzle ORM for all database access (see `/conventions-db`)
- Don't use `?.` or `?? []` to silently handle relations that are
  structural invariants of the data model (e.g. `entity.currentVersion`
  always exists after creation). Use `panic()` instead.
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
- Keep `routes.ts` thin: route files should define the route
  structure, attach macros, choose the HTTP method and path,
  and wire in handlers. When the handler accepts ctx directly
  (e.g. `{ config, handler }` exports), pass `something.handler`
  directly; no arrow wrapper needed. Route-only concerns such as
  `invalidateQuery` stay in `routes.ts`.
- Endpoint modules should default-export one `{ config, handler }`
  object. The `config` owns handler-level concerns such as
  `body`, `params`, `query`, and `permissions`; reusable helpers
  must live in a separate module instead of being exported from
  the endpoint file.
- Backend handlers should be created via
  `createHandler` from `/apps/api/src/lib/api-handlers.ts`.
  Do not export raw workspace-scoped handlers that accept plain
  `WorkspaceContext`; use the branded authorized context that
  `createHandler` provides instead.
- Permission requirements live in the handler file next to the
  schema and business logic. Every workspace-scoped mutation
  handler must declare permissions in `config` and wrap the
  implementation with `createHandler`.
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

Schema in `/apps/api/src/db/schema.ts`. Drizzle ORM for all
access. Full conventions (FK ordering, JSONB, indexes,
transactions) in `/conventions-db`.

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

`use-intl` runtime. Source language: en. Check
`apps/web/src/i18n/langs/` for supported languages. Prefer
reusable `common.*` keys over feature-scoped duplicates. Full
translation flow and key naming rules in `/conventions-i18n`.

## GitHub Interactions

- When commenting on GitHub (PRs, issues), include
  "CC on behalf of @username" where username is the GitHub handle
  of the person who requested the comment.
- This repository (inc. PRs, commits, comments) is public.
  Never include marketing language, internal business context,
  pricing, competitive analysis, user identities, conversation
  specifics, or security architecture beyond what the diff
  shows. Write for the reviewing engineer.

## Linting and Formatting

oxlint handles linting via the **ultracite** preset
(`ultracite/oxlint/core` + `ultracite/oxlint/react`). oxfmt
handles formatting, import sorting, and Tailwind class sorting.
Together they auto-enforce: `for...of` over `.forEach()`,
`const` over `let`, template literals, React hooks rules,
`key` props on iterables, `rel="noopener"` on `target="_blank"`,
no import cycles. If oxlint catches it, trust the linter; don't
duplicate the check in code review.

Run before committing:

```bash
bun run lint && bun run format
```

Lint config: `/.oxlintrc.json`
Format config: `/.oxfmtrc.json`

To suppress a lint rule for one line, use:

```typescript
// eslint-disable-next-line rule-name
```

For example: `// eslint-disable-next-line @typescript-eslint/consistent-type-definitions`

Import order (enforced by oxfmt):

1. React
2. Third-party packages
3. `@stella/*` workspace packages
4. `@/*` path aliases
5. Relative imports
