---
name: conventions-db
description: 'Apply when writing or modifying database schema, queries, migrations, transactions, or tenant-scoped persistence.'
---

# Database Conventions

Apply when writing or modifying database schema, queries, migrations,
transactions, or tenant-scoped persistence.

## Schema

- Schema lives under `apps/api/src/db/schema/`; read the owning slice and
  related foreign keys before editing.
- For closed persisted domain values, define one named `as const` value list
  and pass it to Drizzle with `text({ enum: VALUES })`. Add a database `CHECK`
  when invalid values could compromise lifecycle, authorization, audit, or
  workflow invariants; Drizzle's enum option is compile-time-only.
- Reserve `.$type<T>()` for branded or structured types. Use a native
  PostgreSQL enum only when the value set is genuinely permanent.
- Use cascade deletes for workspace-owned dependants and restrict deletes for
  shared file references. Trace the full FK graph before multi-resource
  deletion.
- Timestamp columns use the `timestamptz` helper from
  `apps/api/src/db/columns.ts`. Never introduce a naive PostgreSQL timestamp or
  `::timestamp` cast without explicitly anchoring its time zone.
- Add indexes for columns used in `WHERE`, `ORDER BY`, or `JOIN`; lead
  composite indexes with the tenant-scoping columns. Treat changes to large
  tables as lock-sensitive.

## Migrations

- `bun --filter @stll/api db:migrate` is the shipped migration path used by CI
  and deployment. `db:push` is a local declarative schema-diff tool; it does
  not replace committed migrations and must not be described as the deployment
  path.
- Schema changes remain additive across a rollout: add, deploy compatible
  reads/writes, backfill in bounded batches, switch, then remove the old shape
  in a later release.
- Migrations run before new API tasks finish rolling out. Old tasks must remain
  compatible with the migrated schema, and a failed rollout must have a safe
  forward-fix path.
- Keep irreversible schema operations out of the same release as risky
  application changes. Destructive, bulk-backfill, and access-control SQL
  requires a statement-scoped acknowledgement enforced by
  `scripts/check-migration-safety.ts`, placed in the comment block directly
  above the statement:
  `-- stella-migration-safety: reviewed <rule-id> - <why this is safe>`.
  An acknowledgement that clears nothing is an error. Every migration sets
  `lock_timeout` and `statement_timeout` first.
- For large live tables, follow the repository's guarded concurrent-index
  protocol: either split and reopen the migrator transaction exactly as
  enforced by `migration-concurrent-index.test.ts`, or put repairable work in
  `online-migrations.ts`. Keep long backfills outside schema migrations and
  checkpoint them durably.
- Validate migration history two ways: apply every committed migration to a
  fresh database, then confirm
  `bun --filter @stll/api db:push -- --explain` reports no schema drift. Do not
  repair drift by resetting a shared database.

## Tenant Scope and Queries

- Workspace data uses the authorized `scopedDb` supplied by safe handlers so
  PostgreSQL RLS and query-level scope reinforce each other. Raw/root database
  access needs a demonstrated system-level reason and a deny-by-default RLS
  posture.
- Ownership IDs come from server-validated context, never request bodies. Keep
  tenant predicates in the database query even when a preceding authorization
  check exists.
- Prefer Drizzle's relational query API for ordinary relation reads. Use
  SQL-like syntax for cross-table filtering, aggregation, locking, unions, or
  mutations where it expresses the invariant more directly.
- Every list query uses a bounded `limit` and cursor and returns the standard
  `Page<T>` envelope from `apps/api/src/lib/pagination.ts`. Offset pagination,
  `totalCount`, and unbounded `findMany` require explicit justification.
- Do not filter unindexed JSONB in request paths. Fetch through indexed tenant
  columns, then narrow structured content with a type guard rather than a cast.
- Batch relation reads and writes. Never issue a query per item when a join,
  relation preload, `IN` query, or bulk mutation can express the same work.

## Concurrency and Transactions

- Keep transactions short; perform S3, network, conversion, and other external
  I/O outside them.
- Close every read-decide-write race. Lock the decisive row with `SELECT ...
  FOR UPDATE`, or encode the expected state/version in the mutation `WHERE`
  clause and check the affected-row count.
- Make retries converge. Stable identities, unique constraints, conditional
  transitions, and idempotency keys are stronger than read-before-insert
  checks.
- Preserve lock order across call sites. When multiple resources must be
  locked, define and reuse a deterministic ordering to avoid deadlocks.

## Verification

Test behavior that schema inference cannot prove: cross-tenant denial,
concurrent transitions, replay/idempotence, migration parity, destructive
delete ordering, and cursor stability under inserts. Prefer invariant or
integration tests over mocked query-shape tests.
