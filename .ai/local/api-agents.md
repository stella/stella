## Database Domain Values

- For closed persisted domain values, use one named `as const` value list with
  Drizzle `text({ enum: VALUES })`; do not use TypeScript enums or native PostgreSQL
  enums for evolving state.
- Drizzle enum inference and `.$type<T>()` do not validate stored values. Add a
  database `CHECK` when an invalid value could compromise lifecycle, billing,
  authorization, audit, or workflow invariants. Reserve `.$type<T>()` for branded or
  structured types.

## Validation Boundary

- Inside a handler, trust the route schema's types: do not re-parse the body or
  re-check ownership the access macro and RLS already guarantee. Valibot runs
  where data enters from JSON columns, webhooks, model output, or storage.
