## Backend (HTTP core)

The API serves `Bun.serve` routes through the in-house HTTP core in
`apps/api/src/http/`; schemas are Valibot (any Standard Schema at the type level).

- Route files build tables with `routes()` from `@/api/http/route`, as in
  `routes({ "/:id": { GET: endpoint } }, { prefix, middleware })`, and compose
  groups with `mount()`. Never spread a group into an array: it keeps the entries
  but drops their route types. Paths and prefixes must be literal strings. [check: typecheck]

- Keep route files thin: paths, methods, mount middleware (such as rate limits) and
  the endpoint definitions. Handler logic and reusable helpers live in their own
  modules. [review]

- Workspace-scoped handlers use `createSafeHandler`; root-scoped handlers use
  `createSafeRootHandler`; session-scoped `createSafeSessionHandler`; endpoints
  that authorize their own token `createSafeTokenHandler`; intentionally public
  ones `createSafePublicHandler`. Public handlers must not receive authenticated
  workspace or root context. Handlers are `async function*` wrapped in
  `Result.gen()`: use `yield* Result.await(safeDb(...))` for DB operations and
  `Result.err(new HandlerError(...))` for error returns. Do not export raw
  handlers that accept plain `WorkspaceContext`; use the branded authorized
  context the factories provide. [review]

- Permission requirements live in the handler file next to the schema and business
  logic. Every workspace-scoped mutation handler declares permissions in `config`. [review]

- Return the answer value for a 200. Use `status(code, body)` from
  `@/api/http/status` for any other status, so the web client types each status. [review]

- The web client's types are computed from the route definitions
  (`RoutesOf<typeof apiRoutes>` in `src/web-contract.ts`, printed into apps/web's
  `@/generated/api-routes.gen`). Do not export schema or response types for the
  client by hand, and do not export types that have no consumer. [review]

- Path segments and query values arrive as strings: read numbers, booleans and
  lists with `numberFromString`, `booleanFromString` and `arrayFromQuery` from
  `@stll/api-contract/http-input`. [review]

- For Valibot objects at untrusted boundaries, prefer `v.strictObject()` over
  `v.object()` unless stripping unknown keys is intentionally desired [review]

- Prefer deriving related Valibot schemas with `v.pick()`, `v.omit()`, and
  `v.partial()` instead of rewriting sibling schemas by hand [review]

- For cross-field form rules, prefer `v.partialCheck()` plus `v.forward()` so the
  issue lands on the relevant field [review]

- Put normalization inside the Valibot schema (`v.trim()`, `v.toLowerCase()`, etc.),
  then use `v.InferInput` for raw form values and `v.InferOutput` after
  parsing/normalization [review]

- Prefer declarative/built-in validators over manual checks (e.g.,
  `fileSchema({ maxBytes })`, `v.isoDate()`, `v.email()`). [review]

- Do not add fallback values for what the boundary already guarantees (a field
  its schema validated). Trust internal code; only add defensive fallbacks at true
  system boundaries (external APIs, user-controlled input). [review]

- File uploads use presigned URLs: client requests a URL from the API, uploads directly
  to S3, then creates the DB record. [review]

- Prefer Bun-native APIs over Web Crypto or manual implementations (e.g.,
  `Bun.CryptoHasher`, `Bun.file`, `Bun.S3Client`). This is a Bun runtime; do not write
  browser-compatible code on the backend. [review]

- Do not use `?.` or `?? []` to silently handle relations that are structural invariants
  of the data model (e.g. `entity.currentVersion` always exists after creation). Use
  `panic()` instead. [review]

## Database Domain Values

Table definitions live in `apps/api/src/db/schema/`; `schema.ts` is the shared
import surface, not the owner of new table definitions.

- For closed persisted domain values, use one named `as const` value list with
  Drizzle `text({ enum: VALUES })`; do not use TypeScript enums or native PostgreSQL
  enums for evolving state. [review]
- Drizzle enum inference and `.$type<T>()` do not validate stored values. Add a
  database `CHECK` when an invalid value could compromise lifecycle, billing,
  authorization, audit, or workflow invariants. Reserve `.$type<T>()` for branded or
  structured types. [review]

## Validation Boundary

- Inside a handler, trust the shape and ownership already validated by its entry
  boundary. Keep business invariants and related-resource authorization in the
  owning operation. Follow `/conventions-security` for shared validation across
  HTTP, generated capabilities, and native tool entry points. [review]
