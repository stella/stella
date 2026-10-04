import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import type { SQLWrapper } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { PgDialect } from "drizzle-orm/pg-core";

import { Temporal } from "@stll/time";

import { systemAuditRuns } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  purgeSystemAuditRuns,
  SYSTEM_AUDIT_PURGE_BATCH_SIZE,
} from "@/api/lib/scheduler/tasks/system-audit-retention";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { systemAuditRow } from "@/api/lib/system-audit/record";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const MIGRATION = new URL(
  "../../drizzle/20261003125100_system_audit_runs/migration.sql",
  import.meta.url,
);
const RUN_ID = toSafeId<"schedulerJobRun">(
  "0192f1d2-0000-7000-8000-000000000001",
);

/**
 * A database where an unprivileged owner role runs the migration, as in
 * production: a superuser bypasses row-level security even when it is forced.
 */
const createDatabase = async () => {
  const db = await PGlite.create();
  await db.exec(`
    CREATE ROLE stella;
    CREATE ROLE app_owner;
    GRANT CREATE ON SCHEMA public TO app_owner;
    SET ROLE app_owner;
  `);
  await db.exec(
    (await Bun.file(MIGRATION).text()).replaceAll(
      "--> statement-breakpoint",
      "",
    ),
  );
  return db;
};

/** The insert the recorder issues for one row, as SQL. */
const insertSql = (counts: { sweptUploads: number }) => {
  const row = systemAuditRow("system:file-comparison-sweep", {
    subject: RUN_ID,
    counts,
  });
  if (row === null) {
    throw new TypeError("Expected a row");
  }
  return drizzle.mock().insert(systemAuditRuns).values(row).toSQL();
};

const deniedOrEmpty = async (run: () => Promise<{ rows: unknown[] }>) => {
  const result = await run().then(
    ({ rows }) => ({ type: "rows" as const, rows }),
    (error: unknown) => ({ type: "error" as const, error: String(error) }),
  );
  return result;
};

test("the application role may only insert system audit runs", async () => {
  await using db = await createDatabase();
  const privileges = await db.query(
    "SELECT privilege, has_table_privilege('stella', 'system_audit_runs', privilege) AS allowed FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS privilege",
  );
  expect(privileges.rows).toEqual([
    { privilege: "SELECT", allowed: false },
    { privilege: "INSERT", allowed: true },
    { privilege: "UPDATE", allowed: false },
    { privilege: "DELETE", allowed: false },
    { privilege: "TRUNCATE", allowed: false },
  ]);

  await db.exec("SET ROLE stella;");
  const { sql, params } = insertSql({ sweptUploads: 2 });
  await db.query(sql, params);

  for (const statement of [
    "UPDATE system_audit_runs SET counts = '{}'::jsonb",
    "DELETE FROM system_audit_runs",
    "SELECT * FROM system_audit_runs",
  ]) {
    const result = await deniedOrEmpty(async () => await db.query(statement));
    expect(result).toMatchObject({
      type: "error",
      error: expect.stringContaining("permission denied"),
    });
  }

  await db.exec("SET ROLE app_owner;");
  expect(
    (await db.query("SELECT actor, subject, counts FROM system_audit_runs"))
      .rows,
  ).toEqual([
    {
      actor: "system:file-comparison-sweep",
      subject: RUN_ID,
      counts: { sweptUploads: 2 },
    },
  ]);
}, 90_000);

test("rows are append-only for the owner too, and checked on the way in", async () => {
  await using db = await createDatabase();
  const { sql, params } = insertSql({ sweptUploads: 1 });
  await db.query(sql, params);

  expect(
    (
      await db.query(
        "UPDATE system_audit_runs SET counts = '{}'::jsonb RETURNING id",
      )
    ).rows,
  ).toEqual([]);

  for (const statement of [
    "INSERT INTO system_audit_runs (id, actor, subject, counts) VALUES (gen_random_uuid(), 'member:someone', 'run', '{}')",
    "INSERT INTO system_audit_runs (id, actor, subject, counts) VALUES (gen_random_uuid(), 'system:x', 'run', '[]')",
    "INSERT INTO system_audit_runs (id, actor, subject, counts) VALUES (gen_random_uuid(), 'system:x', '', '{}')",
  ]) {
    const result = await deniedOrEmpty(async () => await db.query(statement));
    expect(result).toMatchObject({
      type: "error",
      error: expect.stringContaining("check constraint"),
    });
  }
}, 90_000);

test("the purge deletes only rows past retention, in bounded batches", async () => {
  await using db = await createDatabase();
  const now = Temporal.Instant.from("2026-10-04T00:00:00Z");
  const expired = SYSTEM_AUDIT_PURGE_BATCH_SIZE + 5;
  await db.query(
    `INSERT INTO system_audit_runs (id, actor, subject, counts, created_at)
     SELECT gen_random_uuid(), 'system:file-comparison-sweep', 'run-' || n, '{"sweptUploads":1}',
       $1::timestamptz - make_interval(days => 400 + n)
     FROM generate_series(1, ${expired}) AS n`,
    [now.toString()],
  );
  await db.query(
    `INSERT INTO system_audit_runs (id, actor, subject, counts, created_at)
     VALUES (gen_random_uuid(), 'system:file-comparison-sweep', 'kept', '{"sweptUploads":1}',
       $1::timestamptz - make_interval(days => 399))`,
    [now.toString()],
  );
  const dialect = new PgDialect();
  const executor = asTestRaw<SchedulerDb>({
    execute: async (query: SQLWrapper) => {
      const { sql, params } = dialect.sqlToQuery(query.getSQL());
      return (await db.query(sql, params)).rows;
    },
  });

  expect(
    await purgeSystemAuditRuns({
      db: executor,
      now,
      signal: new AbortController().signal,
    }),
  ).toEqual({ deletedRuns: expired, hasMore: false });
  expect(
    (await db.query("SELECT subject FROM system_audit_runs")).rows,
  ).toEqual([{ subject: "kept" }]);
}, 90_000);
