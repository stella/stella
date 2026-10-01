import type { Verdict } from "@stll/db-load-gate/health";

import type { ReplayRowOutcome } from "@/api/handlers/case-law/ingestion/replay";
import { STORED_RAW_REPARSE_REJECTION } from "@/api/lib/legal-search/ingestion-types";

import { caseLawSources } from "./case-law";
import { jsonb, p, safeUuid, sql, timestamptz } from "./common";

export const REPLAY_BATCH_STATUSES = [
  "reserved",
  "completed",
  "superseded",
] as const;
export const REPLAY_BLOCKED_REASONS = [
  "missing-payload",
  ...Object.values(STORED_RAW_REPARSE_REJECTION),
] as const;

// Reservations count toward the daily budget before applying a row. A crash
// leaves the same stable identity available for recovery without spending twice.
export const caseLawReplayBatches = p.pgTable.withRLS(
  "case_law_replay_batches",
  {
    id: p.text().primaryKey(),
    sourceId: safeUuid<"caseLawSource">("source_id")
      .notNull()
      .references(() => caseLawSources.id, { onDelete: "restrict" }),
    firstDecisionId: safeUuid<"caseLawDecision">("first_decision_id").notNull(),
    lastDecisionId: safeUuid<"caseLawDecision">("last_decision_id").notNull(),
    parserVersionFrom: p.integer("parser_version_from"),
    parserVersionTo: p.integer("parser_version_to").notNull(),
    budgetDay: p.date("budget_day").notNull(),
    status: p.text({ enum: REPLAY_BATCH_STATUSES }).notNull(),
    outcome: p.text().$type<ReplayRowOutcome>(),
    attempted: p.integer().notNull(),
    applied: p.integer().default(0).notNull(),
    blocked: p.integer().default(0).notNull(),
    failed: p.integer().default(0).notNull(),
    durationMs: p.integer("duration_ms").default(0).notNull(),
    gateVerdict: jsonb("gate_verdict").$type<Verdict>().notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    completedAt: timestamptz("completed_at"),
  },
  (t) => [
    p
      .index("case_law_replay_batches_source_budget_idx")
      .on(t.sourceId, t.budgetDay),
    p
      .index("case_law_replay_batches_source_status_idx")
      .on(t.sourceId, t.status),
    p.check(
      "case_law_replay_batches_status_check",
      sql`${t.status} IN (${sql.join(
        REPLAY_BATCH_STATUSES.map((status) => sql.raw(`'${status}'`)),
        sql`, `,
      )})`,
    ),
    p.check(
      "case_law_replay_batches_counts_check",
      sql`${t.attempted} > 0 AND ${t.applied} >= 0 AND ${t.blocked} >= 0 AND ${t.failed} >= 0 AND ${t.applied} + ${t.blocked} + ${t.failed} <= ${t.attempted} AND ${t.durationMs} >= 0`,
    ),
    p.pgPolicy("case_law_replay_batches_owner_access", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_batches'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_batches'::regclass)`,
    }),
  ],
);

// A blocked target version is never selected again until the parser advances.
// Decision IDs intentionally have no FK: receipts survive decision cleanup.
export const caseLawReplayBlocked = p.pgTable.withRLS(
  "case_law_replay_blocked",
  {
    sourceId: safeUuid<"caseLawSource">("source_id")
      .notNull()
      .references(() => caseLawSources.id, { onDelete: "restrict" }),
    decisionId: safeUuid<"caseLawDecision">("decision_id").notNull(),
    parserVersionFrom: p.integer("parser_version_from"),
    parserVersionTo: p.integer("parser_version_to").notNull(),
    reason: p.text({ enum: REPLAY_BLOCKED_REASONS }).notNull(),
    detail: p.text(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (t) => [
    p.primaryKey({ columns: [t.decisionId, t.parserVersionTo] }),
    p
      .index("case_law_replay_blocked_source_version_idx")
      .on(t.sourceId, t.parserVersionTo, t.decisionId),
    p.check(
      "case_law_replay_blocked_reason_check",
      sql`${t.reason} IN (${sql.join(
        REPLAY_BLOCKED_REASONS.map((reason) => sql.raw(`'${reason}'`)),
        sql`, `,
      )})`,
    ),
    p.pgPolicy("case_law_replay_blocked_owner_access", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_blocked'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_blocked'::regclass)`,
    }),
  ],
);

// Recovery can charge the same reservation on a later UTC day, once per day.
export const caseLawReplayDailyRows = p.pgTable.withRLS(
  "case_law_replay_daily_rows",
  {
    batchId: p
      .text("batch_id")
      .notNull()
      .references(() => caseLawReplayBatches.id, { onDelete: "restrict" }),
    budgetDay: p.date("budget_day").notNull(),
    sourceId: safeUuid<"caseLawSource">("source_id")
      .notNull()
      .references(() => caseLawSources.id, { onDelete: "restrict" }),
  },
  (t) => [
    p.primaryKey({ columns: [t.batchId, t.budgetDay] }),
    p
      .index("case_law_replay_daily_rows_source_day_idx")
      .on(t.sourceId, t.budgetDay),
    p.pgPolicy("case_law_replay_daily_rows_owner_access", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_daily_rows'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_daily_rows'::regclass)`,
    }),
  ],
);
