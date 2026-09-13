## Handler Scope

- Use `createSafeSessionHandler` for session-scoped endpoints,
  `createSafeTokenHandler` for endpoints that authorize their own token, and
  `createSafePublicHandler` for intentionally public endpoints. Public handlers
  must not receive authenticated workspace or root context.

## Database Domain Values

Table definitions live in `apps/api/src/db/schema/`; `schema.ts` is the shared
import surface, not the owner of new table definitions.

- For closed persisted domain values, use one named `as const` value list with
  Drizzle `text({ enum: VALUES })`; do not use TypeScript enums or native PostgreSQL
  enums for evolving state.
- Drizzle enum inference and `.$type<T>()` do not validate stored values. Add a
  database `CHECK` when an invalid value could compromise lifecycle, billing,
  authorization, audit, or workflow invariants. Reserve `.$type<T>()` for branded or
  structured types.

## Validation Boundary

- Inside a handler, trust the shape and ownership already validated by its entry
  boundary. Keep business invariants and related-resource authorization in the
  owning operation. Follow `/conventions-security` for shared validation across
  HTTP, generated capabilities, and native tool entry points.
