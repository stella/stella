import { panic } from "better-result";
import { sql } from "drizzle-orm";

import type { TransactionOf } from "@/api/db/scoped";
import { executedRows } from "@/api/lib/db/executed-rows";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import plannerSettings from "./planner-settings.json" with { type: "json" };

export const QUERY_PERF_SETTINGS = plannerSettings;
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
  for (const [name, value] of Object.entries(plannerSettings)) {
    // db-await-in-loop: bounded planner GUC file; set each parameter in this measurement session.
    await tx.execute(sql`SELECT set_config(${name}, ${value}, true)`);
  }
};

export const assertPlannerSettings = async (tx: TransactionOf<GatedTestDb>) => {
  for (const [name, value] of Object.entries(plannerSettings)) {
    // db-await-in-loop: bounded planner GUC file; verify every effective value as the measuring role.
    const row = executedRows(
      await tx.execute(sql`SHOW ${sql.identifier(name)}`),
    ).at(0);
    if (row?.[name] !== value) {
      panic(
        `Query perf setting ${name}: expected ${value}, got ${String(row?.[name])}`,
      );
    }
  }
  const row = executedRows(
    await tx.execute(sql`SELECT current_user AS role, current_setting('row_security') AS row_security, current_setting('server_version_num')::integer AS version,
    (SELECT NOT rolbypassrls AND NOT rolsuper FROM pg_roles WHERE rolname = current_user) AS role_enforces_rls,
    (SELECT count(*) = 4 AND bool_and(relrowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('search_documents', 'entities', 'entity_versions', 'workspaces')) AS tables_enforce_rls`),
  ).at(0);
  if (
    row?.["role"] !== "stella" ||
    row["row_security"] !== "on" ||
    typeof row["version"] !== "number" ||
    row["version"] < 180_000 ||
    row["version"] >= 190_000 ||
    row["role_enforces_rls"] !== true ||
    row["tables_enforce_rls"] !== true
  ) {
    panic(
      "Query perf requires PostgreSQL 18 as stella with row security enabled",
    );
  }
};
