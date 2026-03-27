# Database Conventions

Apply when writing or modifying database schema, queries, or
migrations.

## Schema

- Schema lives in `/apps/api/src/db/schema.ts`
- Use Drizzle migrations (`bun run db:push`)
- Cascade deletes for workspace-owned resources
- Restrict deletes for file references (prevent orphaning)
- When writing multi-delete transactions, trace the FK graph
  from `schema.ts` and delete in dependency order: delete the
  parent with cascade FKs first (removing referencing rows),
  then delete restrict-FK targets last.
- JSONB columns for flexible content schemas

## Queries

- Prefer Drizzle's relational query API (`db.query.*.findFirst`,
  `findMany`) over SQL-like syntax (`select().from().where()`).
  Use SQL-like syntax only for cross-table filtering,
  aggregations, unions.
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
