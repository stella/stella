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

## Migrations

- Schema changes must be additive across at least one deploy. Add new
  tables/columns/indexes first, deploy code that can read and write both
  shapes, backfill separately when needed, switch reads/writes, then drop
  the old shape in a later release.
- Remember the deploy order: migrations run before the new API tasks finish
  rolling out. Old API tasks can serve requests against the new schema during
  the rollout, and a failed rollout can leave the old API running on the new
  schema.
- Drizzle does not generate down migrations. If a migration succeeds and the
  application rollout fails, rollback is a manual forward fix unless the old
  application remains schema-compatible.
- Do not include irreversible schema operations in the same release as risky
  application code. Split them into a small migration-only release or an
  additive preparatory release.
- Destructive or backwards-incompatible SQL requires an explicit acknowledgement
  in the migration file. `scripts/check-migration-safety.ts` blocks guarded
  operations such as `DROP`, `TRUNCATE`, `DELETE FROM`, table/column renames,
  dropped constraints, column type changes, and disabling row-level security
  unless the file includes:

  ```sql
  -- stella-migration-safety: reviewed destructive-change - <why this is safe and how rollback is handled>
  ```

- Treat existing large-table changes as lock-sensitive. Prefer `CREATE INDEX
  CONCURRENTLY`, avoid table rewrites in request-critical tables, and backfill
  in bounded batches outside the schema migration when the data volume can grow.

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
