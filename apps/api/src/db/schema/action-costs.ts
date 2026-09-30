import { denyStellaAccessPolicies } from "@/api/db/rls";

import {
  organization,
  p,
  safeOrganizationId,
  sql,
  timestamptz,
  user,
} from "./common";

export const actionCostRecords = p.pgTable(
  "action_cost_records",
  {
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    actionKind: p.text("action_kind").notNull(),
    logicalPhaseId: p.text("logical_phase_id").notNull(),
    userId: p
      .text("user_id")
      .references(() => user.id, { onDelete: "set null" }),
    admittedAt: timestamptz("admitted_at").notNull(),
    settledAt: timestamptz("settled_at"),
    estimatedMicroUnits: p.bigint("estimated_micro_units", { mode: "number" }),
  },
  (table) => [
    p.primaryKey({
      name: "action_cost_records_pkey",
      columns: [table.organizationId, table.actionKind, table.logicalPhaseId],
    }),
    p
      .index("action_cost_records_org_period_kind_idx")
      .on(table.organizationId, table.admittedAt, table.actionKind),
    p.index("action_cost_records_retention_idx").on(table.admittedAt),
    p.check(
      "action_cost_records_estimate_nonneg",
      sql`estimated_micro_units IS NULL OR estimated_micro_units >= 0`,
    ),
    p.check(
      "action_cost_records_time_order",
      sql`settled_at IS NULL OR settled_at >= admitted_at`,
    ),
    p.pgPolicy("action_cost_records_owner_access", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.action_cost_records'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.action_cost_records'::regclass)`,
    }),
    ...denyStellaAccessPolicies(),
  ],
);

// Logical attribution survives a dropped parent observation; reporting counts it.
export const actionCostCalls = p.pgTable(
  "action_cost_calls",
  {
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    actionKind: p.text("action_kind").notNull(),
    logicalPhaseId: p.text("logical_phase_id").notNull(),
    callId: p.text("call_id").notNull(),
    kind: p.text("kind").notNull(),
    occurredAt: timestamptz("occurred_at").notNull(),
    measuredMicroUnits: p.bigint("measured_micro_units", { mode: "number" }),
  },
  (table) => [
    p.primaryKey({
      name: "action_cost_calls_pkey",
      columns: [
        table.organizationId,
        table.actionKind,
        table.logicalPhaseId,
        table.callId,
      ],
    }),
    p
      .index("action_cost_calls_org_period_kind_idx")
      .on(table.organizationId, table.occurredAt, table.actionKind),
    p.index("action_cost_calls_retention_idx").on(table.occurredAt),
    p.check(
      "action_cost_calls_measured_nonneg",
      sql`measured_micro_units IS NULL OR measured_micro_units >= 0`,
    ),
    p.pgPolicy("action_cost_calls_owner_access", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.action_cost_calls'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.action_cost_calls'::regclass)`,
    }),
    ...denyStellaAccessPolicies(),
  ],
);
