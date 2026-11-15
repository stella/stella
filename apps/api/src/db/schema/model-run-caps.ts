import {
  DEFAULT_RUN_CAPS,
  MODEL_RUN_CAP_BOUNDS,
  MODEL_RUN_KINDS,
} from "@/api/lib/usage/model-run-caps/config";

import {
  organization,
  orgPolicies,
  p,
  safeOrganizationId,
  sql,
  stella,
} from "./common";

const RUN_KIND_SQL_VALUES = sql.join(
  MODEL_RUN_KINDS.map((kind) => sql.raw(`'${kind}'`)),
  sql`, `,
);
const ACTIVE_MIN_SQL = sql.raw(String(MODEL_RUN_CAP_BOUNDS.active.min));
const ACTIVE_MAX_SQL = sql.raw(String(MODEL_RUN_CAP_BOUNDS.active.max));
const DAILY_MIN_SQL = sql.raw(String(MODEL_RUN_CAP_BOUNDS.startsPerDay.min));
const DAILY_MAX_SQL = sql.raw(String(MODEL_RUN_CAP_BOUNDS.startsPerDay.max));

const modelRunBudgetOwner = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
  FROM pg_catalog.pg_class WHERE oid = 'public.model_run_budgets'::regclass)`;

/**
 * An organization's counter for one kind of model run: how many of its runs
 * are queued or running, and how many started on the current Europe/Prague
 * day. Run tables' triggers keep it (migration-owned SQL); only
 * `lib/usage/model-run-caps` reads it.
 */
export const modelRunBudgets = p.pgTable.withRLS(
  "model_run_budgets",
  {
    organizationId: safeOrganizationId("organization_id").notNull(),
    // Which kind of run this counter caps (`MODEL_RUN_KINDS`).
    runKind: p.text("run_kind", { enum: MODEL_RUN_KINDS }).notNull(),
    activeRuns: p.integer("active_runs").notNull().default(0),
    startsDay: p
      .date("starts_day", { mode: "string" })
      .notNull()
      .default(sql`stella_model_run_day(CURRENT_TIMESTAMP)`),
    startsToday: p.integer("starts_today").notNull().default(0),
    // The limits in force at the latest start; a worker applies the lower of
    // these and the configured caps.
    activeLimit: p
      .integer("active_limit")
      .notNull()
      .default(DEFAULT_RUN_CAPS.active),
    dailyLimit: p
      .integer("daily_limit")
      .notNull()
      .default(DEFAULT_RUN_CAPS.startsPerDay),
  },
  (table) => [
    p.primaryKey({
      name: "model_run_budgets_pkey",
      columns: [table.organizationId, table.runKind],
    }),
    ...orgPolicies(),
    p
      .foreignKey({
        name: "model_run_budgets_org_fk",
        columns: [table.organizationId],
        foreignColumns: [organization.id],
      })
      .onDelete("cascade"),
    p.pgPolicy("model_run_budgets_owner_access", {
      for: "all",
      to: "public",
      using: modelRunBudgetOwner,
      withCheck: modelRunBudgetOwner,
    }),
    p.pgPolicy("model_run_budgets_no_delete", {
      as: "restrictive",
      for: "delete",
      to: stella,
      using: sql`false`,
    }),
    p.check(
      "model_run_budgets_run_kind_check",
      sql`${table.runKind} IN (${RUN_KIND_SQL_VALUES})`,
    ),
    p.check(
      "model_run_budgets_nonnegative",
      sql`${table.activeRuns} >= 0 AND ${table.startsToday} >= 0`,
    ),
    p.check(
      "model_run_budgets_limits",
      sql`${table.activeLimit} BETWEEN ${ACTIVE_MIN_SQL} AND ${ACTIVE_MAX_SQL} AND ${table.dailyLimit} BETWEEN ${DAILY_MIN_SQL} AND ${DAILY_MAX_SQL}`,
    ),
  ],
);
