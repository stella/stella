import type { Verdict } from "@stll/db-load-gate/health";

import type { BackgroundReplaySource } from "@/api/handlers/case-law/ingestion/background-replay";
import type { ReplayRowOutcome } from "@/api/handlers/case-law/ingestion/replay";
import {
  REPLAY_FAILURE_CODES,
  type ReplayFailure,
  type ReplayPreviewFailure,
} from "@/api/handlers/case-law/ingestion/replay-failure";
import { STORED_RAW_REPARSE_REJECTION } from "@/api/lib/legal-search/ingestion-types";

import { caseLawSources } from "./case-law";
import { jsonb, p, safeUuid, sql, timestamptz } from "./common";

const REPLAY_ATTEMPT_STATES = ["idle", "picked-up"] as const;

export const REPLAY_BATCH_STATUSES = [
  "reserved",
  "completed",
  "superseded",
  "failed",
  "blocked",
] as const;
export const REPLAY_BLOCKED_REASONS = [
  "missing-payload",
  "no-write-settled",
  "redacted",
  "superseded",
  "retry-exhausted",
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
    outcome: p.text().$type<ReplayRowOutcome | ReplayPreviewFailure>(),
    attempted: p.integer().notNull(),
    applied: p.integer().default(0).notNull(),
    blocked: p.integer().default(0).notNull(),
    failed: p.integer().default(0).notNull(),
    durationMs: p.integer("duration_ms").default(0).notNull(),
    gateVerdict: jsonb("gate_verdict").$type<Verdict>().notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    completedAt: timestamptz("completed_at"),
    supersededAt: timestamptz("superseded_at"),
    attempts: p.integer().default(0).notNull(),
    systemicFailures: p.integer("systemic_failures").default(0).notNull(),
    systemicProgress: p
      .bigint("systemic_progress", { mode: "number" })
      .default(0)
      .notNull(),
    attemptState: p
      .text("attempt_state", { enum: REPLAY_ATTEMPT_STATES })
      .default("idle")
      .notNull(),
    retryAt: timestamptz("retry_at"),
    failureCode: p.text("failure_code", { enum: REPLAY_FAILURE_CODES }),
    failureMessageClass: p
      .text("failure_message_class")
      .$type<ReplayFailure["messageClass"]>(),
  },
  (t) => [
    p
      .index("case_law_replay_batches_source_budget_idx")
      .on(t.sourceId, t.budgetDay),
    p
      .index("case_law_replay_batches_source_status_idx")
      .on(t.sourceId, t.status),
    p
      .index("case_law_replay_batches_due_idx")
      .on(t.sourceId, t.status, t.retryAt),
    p
      .index("case_law_replay_batches_document_version_idx")
      .on(t.sourceId, t.firstDecisionId, t.parserVersionTo),
    p
      .index("case_law_replay_batches_retention_idx")
      .on(t.supersededAt, t.id)
      .where(sql`${t.supersededAt} IS NOT NULL`),
    p
      .index("case_law_replay_batches_retire_idx")
      .on(t.sourceId, t.parserVersionTo, t.id)
      .where(
        sql`${t.supersededAt} IS NULL AND ${t.status} IN ('completed', 'superseded', 'failed', 'blocked')`,
      ),
    p.check(
      "case_law_replay_batches_failure_code_check",
      sql`${t.failureCode} IS NULL OR ${t.failureCode} IN (${sql.join(
        REPLAY_FAILURE_CODES.map((code) => sql.raw(`'${code}'`)),
        sql`, `,
      )})`,
    ),
    p.check(
      "case_law_replay_batches_status_check",
      sql`${t.status} IN (${sql.join(
        REPLAY_BATCH_STATUSES.map((status) => sql.raw(`'${status}'`)),
        sql`, `,
      )})`,
    ),
    p.check(
      "case_law_replay_batches_attempt_state_check",
      sql`${t.attemptState} IN (${sql.join(
        REPLAY_ATTEMPT_STATES.map((state) => sql.raw(`'${state}'`)),
        sql`, `,
      )})`,
    ),
    p.check(
      "case_law_replay_batches_counts_check",
      sql`${t.systemicFailures} >= 0 AND ${t.systemicProgress} >= 0 AND ${t.attempts} >= 0 AND ${t.attempted} > 0 AND ${t.applied} >= 0 AND ${t.blocked} >= 0 AND ${t.failed} >= 0 AND ${t.applied} + ${t.blocked} + ${t.failed} <= ${t.attempted} AND ${t.durationMs} >= 0`,
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
    batchId: p.text("batch_id").notNull(),
    budgetDay: p.date("budget_day").notNull(),
    sourceId: safeUuid<"caseLawSource">("source_id")
      .notNull()
      .references(() => caseLawSources.id, { onDelete: "restrict" }),
  },
  (t) => [
    p.primaryKey({ columns: [t.batchId, t.budgetDay] }),
    p
      .foreignKey({
        name: "case_law_replay_daily_batch_fk",
        columns: [t.batchId],
        foreignColumns: [caseLawReplayBatches.id],
      })
      .onDelete("restrict"),
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

export const caseLawReplaySourceProgress = p.pgTable.withRLS(
  "case_law_replay_source_progress",
  {
    sourceId: safeUuid<"caseLawSource">("source_id").notNull(),
    ticksWithoutProgress: p
      .integer("ticks_without_progress")
      .default(0)
      .notNull(),
    lastCompletedAt: timestamptz("last_completed_at"),
    completedRows: p
      .bigint("completed_rows", { mode: "number" })
      .default(0)
      .notNull(),
  },
  (t) => [
    p.primaryKey({
      columns: [t.sourceId],
      name: "case_law_replay_source_progress_pkey",
    }),
    p
      .foreignKey({
        name: "case_law_replay_progress_source_fk",
        columns: [t.sourceId],
        foreignColumns: [caseLawSources.id],
      })
      .onDelete("restrict"),
    p.check(
      "case_law_replay_source_progress_ticks_check",
      sql`${t.ticksWithoutProgress} >= 0 AND ${t.completedRows} >= 0`,
    ),
    p.pgPolicy("case_law_replay_source_progress_owner_access", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_source_progress'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_source_progress'::regclass)`,
    }),
  ],
);

export const REPLAY_MAINTENANCE_AUDIT_ACTIONS = [
  "source-scheduled",
  "daily-row-charged",
  "receipt-superseded",
  "checkpoint-created",
  "gate-state-saved",
  "receipt-reserved",
  "progress-completed",
  "receipt-applied",
  "receipt-failed",
  "receipt-blocked",
  "dry-run-advanced",
  "dry-run-reset",
  "receipts-compacted",
  "tick-recorded",
] as const;
export const REPLAY_MAINTENANCE_AUDIT_SERVICE = "case-law-background-replay";
export type ReplayMaintenanceAuditDetails = {
  mode?: BackgroundReplaySource["mode"];
  kind?: "reviewed" | "retry-exhausted";
  attempts?: number;
  failureCode?: ReplayFailure["code"];
  status?: (typeof REPLAY_BATCH_STATUSES)[number];
  parserVersion?: number;
  ticksWithoutProgress?: number;
  compactedReceipts?: number;
  compactedAuditEvents?: number;
};

// Independent of receipt FKs: audit history survives bounded receipt compaction.
// Source deletion is explicit and restricted while its retained history exists.
export const caseLawReplayAuditEvents = p.pgTable.withRLS(
  "case_law_replay_audit_events",
  {
    id: p.text().notNull(),
    sourceId: safeUuid<"caseLawSource">("source_id"),
    serviceId: p.text("service_id").notNull(),
    action: p.text({ enum: REPLAY_MAINTENANCE_AUDIT_ACTIONS }).notNull(),
    resourceId: p.text("resource_id").notNull(),
    details: jsonb().$type<ReplayMaintenanceAuditDetails>().notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (t) => [
    p.primaryKey({
      columns: [t.id],
      name: "case_law_replay_audit_events_pkey",
    }),
    p
      .foreignKey({
        name: "case_law_replay_audit_source_fk",
        columns: [t.sourceId],
        foreignColumns: [caseLawSources.id],
      })
      .onDelete("restrict"),
    p.index("case_law_replay_audit_events_retention_idx").on(t.createdAt, t.id),
    p
      .index("case_law_replay_audit_events_source_idx")
      .on(t.sourceId, t.createdAt, t.id),
    p.check(
      "case_law_replay_audit_events_action_check",
      sql`${t.action} IN (${sql.join(
        REPLAY_MAINTENANCE_AUDIT_ACTIONS.map((action) =>
          sql.raw(`'${action}'`),
        ),
        sql`, `,
      )})`,
    ),
    p.check(
      "case_law_replay_audit_events_service_check",
      sql`${t.serviceId} = ${REPLAY_MAINTENANCE_AUDIT_SERVICE}`,
    ),
    p.check(
      "case_law_replay_audit_events_details_check",
      sql`jsonb_typeof(${t.details}) = 'object' AND octet_length(${t.details}::text) <= 32768`,
    ),
    p.pgPolicy("case_law_replay_audit_events_owner_access", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_audit_events'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_audit_events'::regclass)`,
    }),
  ],
);
