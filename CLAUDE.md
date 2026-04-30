# Stella Development Guidelines

Stella is an open-source legal workspace.

## Ideal Customer Profile (ICP)

**Current focus: mid-size law firms, 5–50 lawyers.**
Pragmatic, cost-conscious, not overly technical.

**Scale target: Magic Circle firms (2,000–5,000+ lawyers).**
The architecture must not block scaling to this level. See the Scalability section
below for decision guidelines.

International audience: do not assume English language or English typography
conventions are universal. Highlight competing standards (date formats, quotation
marks, citation styles, legal terminology) when relevant.

## Project Overview

**Monorepo:** `apps/api` (Elysia backend, Bun), `apps/web` (React + Vite frontend),
shared packages in `packages/`. Use Glob/Grep to explore.

## Workspace Layout

- `apps/*` contains runnable applications only.
- `packages/*` contains shared or publishable packages only.
- Every direct child of `apps/` and `packages/` must be a workspace package named
  `@stll/<directory>`.
- Use scoped workspace filters in commands, for example
  `bun --filter @stll/web dev`.

## Commands

`bun run dev` | `dev:web` (3000) | `dev:api` (3001) |
`build` | `lint` | `format` | `typecheck` | `test` |
`db:push`

## Documentation Access

The `stella-docs` MCP server provides on-demand access to library documentation via
`llms.txt`. When implementing features, fetch the relevant docs first using
`list_doc_sources` and `fetch_docs` tools.

**Not covered (no `llms.txt`):** Tailwind CSS, oxfmt. For these, use `WebFetch` or
`WebSearch` directly.

**Setup:** run `bun run setup:mcp` once after cloning.

## Meta Preferences

- Never manually reformat code you did not semantically change (auto-formatter
  output from `bun run format` is fine to include)
- Vary punctuation: prefer colons, semicolons, commas, and parentheses over em dashes
- Prefer explicit over implicit — when a backend endpoint accepts a discriminator
  (e.g., `?type=document|file`), thread it through the full stack (URL params,
  component props) instead of hardcoding a default on the frontend
- If TypeScript can make a class of bug structurally impossible (branded types,
  discriminated unions, exhaustive checks), prefer that over runtime validation or
  manual discipline
- Conventional Commits: `feat:`, `chore:`, `fix:`, `docs:`
- Rebase feature branches onto main (linear history)
- Fail fast — validate at boundaries, return/throw early
- Minimize brace nesting — invert conditions, early returns
- Use named constants, not string literals for domain values
- No direct `document.cookie` assignment
- Avoid spread in loop accumulators (use `.push()`)
- If you encounter a pre-existing bug or lint error while working on something else,
  fix it (separate commit)

## Regulated Industry

Stella handles privileged legal data. All code must meet **SOC 2 Type II** and
**ISO 27001** standards: least privilege, audit trails, encryption, workspace
isolation, ethical walls. Full checklist in `/conventions-security`.

## Design Principles

- No hidden complexity; code is the docs. Every operation must work for humans,
  scripts, and AI agents alike.
- No lock-in: standard formats, self-hosting is first-class.
- AI is a tool, not a persona. No anthropomorphizing.
- Performance is non-negotiable. Batch operations, minimize round-trips, lazy-load
  aggressively.
- **Vertical slices over horizontal layers.** Features are independent end-to-end
  slices (own routes, components, handlers). New capabilities land in their own slice;
  existing code stays untouched.

## Scalability

Never paint yourself into a corner. Architecture must support Magic Circle scale
without a rewrite. Never return unbounded result sets; keep the API stateless; filter
by tenant ID in the query. Full guidelines in `/conventions-scale`.

## UX & Brand

Use semantic tokens (`bg-muted`, `text-foreground`, `border`), not raw colour values.
Full brand deck, micro-interaction guidelines, and visual noise rules in
`/conventions-ux`.

## Coding Conventions

### TypeScript

- No enums — use `as const` objects or union types
- Model mutually exclusive internal states as discriminated unions with a stable
  `type`, `status`, or domain-specific discriminator. Avoid boolean flag sets plus
  optional payload fields when only some combinations are valid.
- When the linter blocks an `as` cast, restructure to narrow properly (type guards,
  `in` checks, records instead of arrays). If truly unavoidable, ask before adding and
  include a `// SAFETY:` comment explaining why the cast is sound.
- When a type mismatch appears, trace it to the source (e.g., the handler or query
  that produces the wrong type) rather than casting at the consumer. Check git to
  verify you didn't introduce the mismatch yourself before blaming the framework.
- Use `.at(0)` when the element may not exist (signals possible absence). Use `[0]`
  only when existence is already established (length check, or a `// SAFETY:` comment).
- Prefer arrow functions over function expressions
- Destructure in the parameter when the intermediate variable is not reused
  (e.g., `{ body: { file, name } }` not `body` then `const { file, name } = body`)
- Prefer discriminated union narrowing (`obj.type === "x"`) over `"key" in obj`
  checks. Use `in` only when the type is not a discriminated union and there is no
  discriminator to check.
- For function arguments, including helpers: use normal typed parameters for one
  argument, and also for two arguments when their types are different enough to stay
  readable. Use a named `SomethingOptions`, `SomethingArgs`, or `SomethingParams`
  object for 3+ arguments, or when two same-type or otherwise interchangeable
  positional arguments would be easy to mix up. Reserve `Props` for React component
  props.
- Reuse util types from libraries instead of hand-rolling (e.g.,
  `React.PropsWithChildren<P>` for props with children,
  `React.ComponentProps<"button">` for HTML element props). Check React, TanStack, and
  other deps before defining custom equivalents.
- Keep helper-local types close to the helper they describe: put `SomethingOptions`,
  `SomethingResult`, and similar aliases immediately above the function, not in a
  file-level type dump far away from the implementation.
- If a return type is noisy enough to hurt readability, hoist it into a nearby alias
  such as `SomethingResult` and use it in the signature (e.g., `SomethingResult` or
  `Promise<SomethingResult>`). If the return type is simple, keep it inline.

### Module Side Effects

- **No module-level side effects in shared modules.** If a module exports both a
  side-effecting singleton (DB connection, auth client, pool) and reusable utilities,
  split them: put utilities in a separate file so consumers can import them without
  triggering initialization. The side-effecting module re-exports for convenience.
- **Never import test-only types in prod code.** If a prod generic needs to accept
  both prod and test instances, use a structural constraint (`{ transaction: ... }`)
  instead of importing a type from a test file.
- **Defer eager initialization with lazy singletons.** When a module-level call
  (`betterAuth()`, `drizzle()`) depends on another module's export, wrap it in a
  `getX()` getter so it runs at first use, not at import time. This prevents TDZ
  errors from non-deterministic module evaluation order.

### React

- Put the root/exported component at the top of the file (after imports); helper
  components and types follow below.
- Prefer `if` statements over nested ternaries for conditional rendering. Extract
  complex logic into a small component that returns early with `if` branches instead
  of chaining ternaries.
- React Compiler is enabled in the Vite build. Prefer plain React over prophylactic
  `useMemo`, `useCallback`, and `React.memo`.
- Clean up legacy memoization gradually when touching a file; do not do broad
  mechanical removals. Keep manual memoization only when a library contract requires
  referential stability or profiling proves a real benefit.
- Zustand with `useShallow()` for multi-slice selectors
- Skip barrel files (`index.ts`) — import from explicit paths
- Use coss (Base UI) components — registered as `@coss` in `components.json`. Prefer
  coss primitives over hand-rolling.
- Use semantic HTML elements (`<button>`, `<nav>`, `<main>`) over generic `<div>`s with
  ARIA roles. Provide meaningful `alt` text, proper heading hierarchy, labels for form
  inputs, and keyboard event handlers alongside mouse events.
- Never construct Tailwind class names dynamically (e.g. `` `bg-${color}-200` ``);
  Tailwind can't detect them. Use `style` with CSS variables instead
  (e.g. ``style={{ backgroundColor: `var(--color-${name}-200)` }}``).
- `cn()` utility for conditional class names
- Frontend calls the API via Eden treaty (`apps/web/src/lib/api.ts`). The `api` export
  is a typed proxy mirroring backend routes; use dot notation with HTTP verbs:
  `api.workspaces({ workspaceId }).get()`. Unwrap responses with `.data` / `.error`
  checks or `toAPIError()`.
- Return minimal data from endpoints and mutations. Backend handlers should only return
  what callers actually need; frontend response types should only type what they
  consume. Don't speculatively return extra fields "for completeness."
- Don't create single-use mutation hooks just to wrap an API call. Inline the API call
  at the usage site and use `Result.tryPromise` for retries instead of React Query's
  `retry` on throwaway mutations.
- Reuse existing components (`Button`, `Input`, etc.) with `className` overrides
  instead of writing inline `<button>`, `<input>`, or similar raw HTML elements. This
  keeps behaviour (focus rings, accessibility, sizing) consistent across the app.
- Prefer `useRouteContext` for data already provided by parent route loaders
  (`beforeLoad`) over firing a separate query. Extend the route context if needed
  rather than adding a query.
- Use `useSuspenseQuery` only in route/page content where the query is preloaded or
  wrapped by an explicit local `Suspense` boundary. In shared chrome (breadcrumbs,
  headers, toolbars, sidebar shell), prefer `useQuery` so a cache miss cannot suspend
  the whole layout.
- Always use `select` with `useParams`, `useSearch`, and `useRouteContext` to subscribe
  only to the fields the component needs. Without `select`, the component rerenders on
  any param/search/context change.
- Use `useDebouncedCallback` from `use-debounce` instead of hand-rolling debounce with
  `useRef<setTimeout>` + manual `clearTimeout`. The library handles cleanup
  automatically.
- Query option file ordering: key type → key helpers → input type
  (`QueryOptionsInput`) → option factory → hook (e.g., `useEntitiesOptions`).
- Query option factories that use `QueryOptionsInput` with a `TContext` must: define a
  named type alias matching the factory name (e.g., `ViewsOptionsInput` for
  `viewsOptions`, `ChatThreadOptionsInput` for `chatThreadOptions`), destructure
  `{ key, context }` in the parameter, and reference `key.*` / `context.*` directly in
  the body (no further destructuring). This makes it obvious at the call site and
  inside the function which values drive the cache key vs. which are runtime-only deps.
- Define a separate key type (e.g., `EntitiesPageKey`) and use it in both the
  `QueryOptionsInput` and the key helper. The key helper's parameter type must be the
  key type, not the full options input, so the key builder only accepts cache-identity
  fields.
- Never spread input objects into query keys. Explicitly destructure and reconstruct
  the key object so extra properties from callers cannot leak into the cache identity
  and cause spurious refetches.
- Key helpers must compose by spreading the parent key
  (e.g., `...entitiesKeys.all(workspaceId)`), never by duplicating the parent's array
  literal. This ensures changes to the parent key shape propagate automatically.

### Backend (Elysia)

- Don't export types that have no consumer. Elysia infers handler types via Eden;
  manually exporting schema types is unnecessary unless explicitly imported elsewhere.
- Prefer Bun-native APIs over Web Crypto or manual implementations (e.g.,
  `Bun.CryptoHasher`, `Bun.file`, `Bun.S3Client`). This is a Bun runtime; don't write
  browser-compatible code on the backend.
- Drizzle ORM for all database access (see `/conventions-db`)
- Don't use `?.` or `?? []` to silently handle relations that are structural invariants
  of the data model (e.g. `entity.currentVersion` always exists after creation). Use
  `panic()` instead.
- Timeouts on all external calls:

  ```typescript
  fetch(url, { signal: AbortSignal.timeout(10_000) });
  ```

- Validate inputs at the boundary with Valibot or Elysia schemas
- Prefer one obvious validation split: use Elysia `t` for HTTP route contracts,
  Valibot for web and general runtime validation, and Zod only when a dependency
  explicitly requires it
- For Valibot objects at untrusted boundaries, prefer `v.strictObject()` over
  `v.object()` unless stripping unknown keys is intentionally desired
- Prefer deriving related Valibot schemas with `v.pick()`, `v.omit()`, and
  `v.partial()` instead of rewriting sibling schemas by hand
- For cross-field form rules, prefer `v.partialCheck()` plus `v.forward()` so the
  issue lands on the relevant field
- Put normalization inside the Valibot schema (`v.trim()`, `v.toLowerCase()`, etc.),
  then use `v.InferInput` for raw form values and `v.InferOutput` after
  parsing/normalization
- Prefer declarative/built-in validators over manual checks (e.g.,
  `t.File({ maxSize })`, `v.isoDate()`, `v.email()`).
- Don't add fallback values for properties that the framework already guarantees
  (e.g., `file.type || "..."` when Elysia's `t.File()` always provides a type). Trust
  internal code and framework guarantees; only add defensive fallbacks at true system
  boundaries (external APIs, user-controlled input).
- Keep `routes.ts` thin: route files should define the route structure, attach macros,
  choose the HTTP method and path, and wire in handlers. When the handler accepts ctx
  directly (e.g. `{ config, handler }` exports), pass `something.handler` directly; no
  arrow wrapper needed. Route-only concerns such as `invalidateQuery` stay in
  `routes.ts`.
- Endpoint modules should default-export one `{ config, handler }` object. The
  `config` owns handler-level concerns such as `body`, `params`, `query`, and
  `permissions`; reusable helpers must live in a separate module instead of being
  exported from the endpoint file.
- Backend handlers should be created via `createSafeHandler` (workspace-scoped) or
  `createSafeRootHandler` (root-scoped) from `/apps/api/src/lib/api-handlers.ts`.
  Both wrap handlers in `Result.gen()` for structured error capture. Use
  `async function*` with `yield* Result.await(safeDb(...))` for DB operations and
  `Result.err(new HandlerError(...))` for error returns. Do not export raw handlers
  that accept plain `WorkspaceContext`; use the branded authorized context that the
  safe handler factories provide instead.
- Permission requirements live in the handler file next to the schema and business
  logic. Every workspace-scoped mutation handler must declare permissions in `config`
  and wrap the implementation with `createSafeHandler`.
- **Ownership IDs come from server-validated sources.** `workspaceId` from `SafeId` via
  `validateWorkspaceAccess`, `organizationId` from
  `ctx.session.activeOrganizationId`. The `no-body-ownership-ids` lint rule catches
  body/query violations; this guideline covers the architectural intent. Before writing
  a new handler, read an existing handler with the same scope to follow the established
  pattern.
- File uploads use presigned URLs: client requests a URL from the API, uploads directly
  to S3, then creates the DB record.

### Known Elysia Gotchas

- **Optional UnionEnum coercion:** Elysia coerces absent optional `UnionEnum` fields to
  the first enum value. Always send all fields explicitly from the frontend, even when
  the value hasn't changed.
- **Function-form macros break type inference.** Define macros in a separate Elysia
  plugin, not chained inline. The function form (`(app) => app.macro(...)`) loses type
  propagation.

### Error Handling

- Use `better-result` for typed error handling. Do not use try-catch for control flow;
  wrap failable operations with `Result` instead. Try-catch is only acceptable at
  boundary layers (top-level request handlers, framework hooks).
- Split error semantics deliberately: use `panic(...)` for impossible internal
  invariants and programmer misuse, `TaggedError` subclasses for expected
  business/config/runtime failures, and analytics/logging capture for telemetry-only
  paths that continue execution.
- Prefer tagged errors (`APIError`, `TaggedError` subclasses) over bare `new Error()`.
  Tagged errors carry structured context (status, cause) for error handling and
  reporting. Every `TaggedError` must include a `message: string` field.
- All errors must be surfaced to the user (toast) or propagated to the caller. Capture
  errors before throwing (PostHog). Never swallow errors silently.
- Do not leave ad hoc `console.error(...)` in product code. Route telemetry-only
  failures through the shared analytics or logging helpers so observability stays
  structured.

### Database

Schema in `/apps/api/src/db/schema.ts`. Drizzle ORM for all access. Full conventions
(FK ordering, JSONB, indexes, transactions) in `/conventions-db`.

### Testing

Only test what can actually go wrong — bugs the type system, framework, or linter
would miss. Prefer invariants over examples when the input space is large. Full
conventions in `/conventions-testing`.

## Internationalization (i18n)

`use-intl` runtime. Source language: en. Check `apps/web/src/i18n/langs/` for
supported languages. Prefer reusable `common.*` keys over feature-scoped duplicates.
Full translation flow and key naming rules in `/conventions-i18n`.

## Linting

oxlint (ultracite preset) + oxfmt. To suppress a rule:
`// eslint-disable-next-line rule-name`

## GitHub Interactions

- When commenting on GitHub (PRs, issues), include "CC on behalf of @username" where
  username is the GitHub handle of the person who requested the comment.
- This repository (inc. PRs, commits, comments) is public. Never include marketing
  language, internal business context, pricing, competitive analysis, user identities,
  conversation specifics, or security architecture beyond what the diff shows. Write
  for the reviewing engineer.
