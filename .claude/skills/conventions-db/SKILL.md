---
name: conventions-db
description: "Apply when writing or modifying database schema, queries, migrations, transactions, or tenant-scoped persistence."
---

# Database Conventions

Apply when writing or modifying database schema, queries, migrations,
transactions, or tenant-scoped persistence.

## Schema

Schema lives under `apps/api/src/db/schema/`; read the owning slice and related
foreign keys before editing. To learn whether something is stored and where,
search the generated index first: `rg <word> apps/api/src/db/schema-index` gives
one line per column with its builder, flags, `file:line` and the first sentence
of its comment, so lead a column's comment with what the column means.

- Reserve `.$type<T>()` for branded or structured types. Use a native
  PostgreSQL enum only when the value set is genuinely permanent. [review]
- Use cascade deletes for workspace-owned dependants and restrict deletes for
  shared file references. Trace the full FK graph before multi-resource
  deletion. [review]
- Add indexes for columns used in `WHERE`, `ORDER BY`, or `JOIN`; lead
  composite indexes with the tenant-scoping columns. Treat changes to large
  tables as lock-sensitive. [review]

## Migrations

### Expand-only pre-deploy phase

SQL migrations are a blocking pre-deploy phase, so keep them expand-only: add
tables or columns, add constraints as `NOT VALID`, and use only short-lock DDL.
Never put data backfills, `CREATE [UNIQUE] INDEX CONCURRENTLY`, or
`ALTER TABLE ... VALIDATE CONSTRAINT` in a migration. Governed, bounded
backfills belong to `apps/api/src/db/backfill-runtime.ts` and registered online
repairs and concurrent index builds (`ONLINE_MIGRATION_INDEXES`) in
`apps/api/src/db/online-migrations.ts`.
[check: scripts/check-migration-safety.ts, .github/workflows/ci.yml]

- `bun --filter @stll/api db:migrate` is the shipped migration path used by CI
  and deployment. `db:push` is a local declarative schema-diff tool; it does
  not replace committed migrations and must not be described as the deployment
  path. [check: .github/workflows/ci.yml]

- Schema changes remain additive across a rollout: add, deploy compatible
  reads/writes, backfill in bounded batches, switch, then remove the old shape
  in a later release. [check: scripts/check-migration-safety.ts]
- Migrations run before new API tasks finish rolling out. Old tasks must remain
  compatible with the migrated schema, and a failed rollout must have a safe
  forward-fix path. [review]
- Keep irreversible schema operations out of the same release as risky
  application changes. Destructive and access-control SQL requires a
  statement-scoped acknowledgement enforced by
  `scripts/check-migration-safety.ts`, placed in the comment block directly
  above the statement:
  `-- stella-migration-safety: reviewed <rule-id> - <why this is safe>`.
  An acknowledgement that clears nothing is an error. Every migration sets
  `lock_timeout` and `statement_timeout` first.
  [check: scripts/check-migration-safety.ts, scripts/check-migration-locks.ts]
- Keep repairable work in `online-migrations.ts`. Long backfills stay outside
  schema migrations and checkpoint durably.
  [test: apps/api/src/db/online-migrations.test.ts]
- A migration directory's name is its identity: the migrator applies every
  directory whose name the database has not recorded, in name order. Never
  rename or delete a merged migration; add a new one instead.
  [check: scripts/check-migration-order.ts]
- New timestamps sort after the newest migration on the base branch. [review]

- Validate migration history two ways: apply every committed migration to a
  fresh database, then confirm
  `bun --filter @stll/api db:push -- --explain` reports no schema drift. Do not
  repair drift by resetting a shared database.
  [check: .github/workflows/ci.yml]

## Tenant Scope and Queries

Prefer Drizzle's relational query API for ordinary relation reads, and SQL-like
syntax where it states the invariant more directly (cross-table filters,
aggregation, locking, unions, mutations).

- Workspace data uses the authorized `scopedDb` supplied by safe handlers so
  PostgreSQL RLS and query-level scope reinforce each other. Raw/root database
  access needs a demonstrated system-level reason and a deny-by-default RLS
  posture. [check: ratchet:direct-root-connection-imports]
- Do not filter unindexed JSONB in request paths. Fetch through indexed tenant
  columns, then narrow structured content with a type guard rather than a cast.
  [review]

## Concurrency and Transactions

- Keep transactions short; perform S3, network, conversion, and other external
  I/O outside them. [review]
- Close every read-decide-write race. Lock the decisive row with
  `SELECT ... FOR UPDATE`, or encode the expected state/version in the
  mutation `WHERE` clause and check the affected-row count. [review]

- Make retries converge. Stable identities, unique constraints, conditional
  transitions, and idempotency keys are stronger than read-before-insert
  checks. [review]
- Preserve lock order across call sites. When multiple resources must be
  locked, define and reuse a deterministic ordering to avoid deadlocks.
  [review]

## Verification

Test behavior that schema inference cannot prove: cross-tenant denial,
concurrent transitions, replay/idempotence, migration parity, destructive
delete ordering, and cursor stability under inserts. Prefer invariant or
integration tests over mocked query-shape tests.
