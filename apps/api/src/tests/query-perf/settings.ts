import { panic } from "better-result";
import { type SQL, sql } from "drizzle-orm";
import * as v from "valibot";

import type { TransactionOf } from "@/api/db/scoped";
import { executedRows } from "@/api/lib/db/executed-rows";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import plannerSettings from "./planner-settings.json" with { type: "json" };

// Startup settings cover seed, VACUUM, policy DDL and database DDL outside transactions.
export const QUERY_PERF_CONNECTION_SETTINGS = {
  statement_timeout: 30_000,
  lock_timeout: 3000,
} as const;
export const QUERY_PERF_DIAGNOSTIC_CONNECTION_SETTINGS = {
  statement_timeout: 2000,
  lock_timeout: 1000,
} as const;
export const QUERY_PERF_JIT = () => {
  switch (plannerSettings.jit) {
    case "on":
      return "on";
    case "off":
      return "off";
    default:
      return panic("Query perf jit must be on or off");
  }
};

export const applyPlannerSettings = async (tx: TransactionOf<GatedTestDb>) => {
  // Literal names keep timeout mutations auditable; the total map prevents unapplied settings.
  const settings = {
    jit: sql`set_config('jit', ${plannerSettings.jit}, true)`,
    work_mem: sql`set_config('work_mem', ${plannerSettings.work_mem}, true)`,
    random_page_cost: sql`set_config('random_page_cost', ${plannerSettings.random_page_cost}, true)`,
    seq_page_cost: sql`set_config('seq_page_cost', ${plannerSettings.seq_page_cost}, true)`,
    effective_cache_size: sql`set_config('effective_cache_size', ${plannerSettings.effective_cache_size}, true)`,
    effective_io_concurrency: sql`set_config('effective_io_concurrency', ${plannerSettings.effective_io_concurrency}, true)`,
    default_statistics_target: sql`set_config('default_statistics_target', ${plannerSettings.default_statistics_target}, true)`,
    max_parallel_workers_per_gather: sql`set_config('max_parallel_workers_per_gather', ${plannerSettings.max_parallel_workers_per_gather}, true)`,
  } satisfies Record<keyof typeof plannerSettings, SQL>;
  await tx.execute(sql`SELECT ${sql.join(Object.values(settings), sql`, `)}`);
};

/** The measuring role: `stella` under row security, or the fixture's owner. */
type MeasuringRole = "stella" | "owner";

export const assertPlannerSettings = async (
  tx: TransactionOf<GatedTestDb>,
  role: MeasuringRole = "stella",
) => {
  for (const [name, value] of Object.entries(plannerSettings)) {
    // db-await-in-loop: bounded planner GUC file; verify every effective value as the measuring role.
    const row = v.parse(
      v.record(v.string(), v.string()),
      executedRows(await tx.execute(sql`SHOW ${sql.identifier(name)}`)).at(0),
    );
    if (row[name] !== value) {
      panic(
        `Query perf setting ${name}: expected ${value}, got ${String(row[name])}`,
      );
    }
  }
  if (role === "owner") {
    // Public corpus statements run as the scheduler's owner role; only the
    // server version is asserted.
    const { version } = v.parse(
      v.strictObject({ version: v.number() }),
      executedRows(
        await tx.execute(
          sql`SELECT current_setting('server_version_num')::integer AS version`,
        ),
      ).at(0),
    );
    if (version < 180_000 || version >= 190_000) {
      panic("Query perf requires PostgreSQL 18");
    }
    return;
  }
  const row = v.parse(
    v.strictObject({
      role: v.string(),
      row_security: v.string(),
      version: v.number(),
      role_enforces_rls: v.boolean(),
      tables_enforce_rls: v.boolean(),
    }),
    executedRows(
      await tx.execute(sql`SELECT current_user AS role, current_setting('row_security') AS row_security, current_setting('server_version_num')::integer AS version,
    (SELECT NOT rolbypassrls AND NOT rolsuper FROM pg_roles WHERE rolname = current_user) AS role_enforces_rls,
    (SELECT count(*) = 4 AND bool_and(relrowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('search_documents', 'entities', 'entity_versions', 'workspaces')) AS tables_enforce_rls`),
    ).at(0),
  );
  if (
    row.role !== "stella" ||
    row.row_security !== "on" ||
    row.version < 180_000 ||
    row.version >= 190_000 ||
    !row.role_enforces_rls ||
    !row.tables_enforce_rls
  ) {
    panic(
      "Query perf requires PostgreSQL 18 as stella with row security enabled",
    );
  }
};
