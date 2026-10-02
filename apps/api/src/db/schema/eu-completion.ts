import type { BatchState } from "@stll/db-load-gate/health";

import { caseLawSources } from "./case-law";
import { jsonb, p, safeUuid, sql, timestamptz } from "./common";

export const EU_COMPLETION_STATUSES = [
  "pending",
  "fetched",
  "applied",
  "unchanged",
  "review-required",
  "publisher-refused",
  "failed-backoff",
  "failed",
  "dry-run",
  "too-large",
  "publisher-gone",
  "superseded-by-crawl",
  "withdrawn",
] as const;
export const EU_COMPLETION_MODES = ["dry-run", "apply"] as const;
export const EU_COMPLETION_TARGETS = ["formex", "full"] as const;
export const EU_COMPLETION_CONTROL_STATES = ["off", "on"] as const;
const RETRY_STATUSES = [
  "failed-backoff",
  "failed",
  "superseded-by-crawl",
] as const satisfies readonly (typeof EU_COMPLETION_STATUSES)[number][];
const ATTEMPT_STATES = ["idle", "picked-up", "repair"] as const;
export const EU_COMPLETION_PAYLOAD_MAX_BYTES = 16 * 1024 * 1024;
export const EU_COMPLETION_REQUESTS_PER_HOUR = 3600;
export type EuCompletionReviewedCounts = {
  reviewed: number;
  accepted: number;
  requiresReview: number;
};
export type EuCompletionProvenance = {
  requestHashes: string[];
  requestedSurfaces: string[];
};

export const euCompletionReceipts = p.pgTable.withRLS(
  "eu_completion_receipts",
  {
    id: p.text().notNull(),
    sourceId: safeUuid<"caseLawSource">("source_id").notNull(),
    decisionId: safeUuid<"caseLawDecision">("decision_id").notNull(),
    mode: p.text({ enum: EU_COMPLETION_MODES }).notNull(),
    parserVersion: p.integer("parser_version").notNull(),
    status: p.text({ enum: EU_COMPLETION_STATUSES }).notNull(),
    target: p.text({ enum: EU_COMPLETION_TARGETS }),
    claimedSourceHash: p.text("claimed_source_hash"),
    completionSourceHash: p.text("completion_source_hash"),
    claimedObservationOrder: p.bigint("claimed_observation_order", {
      mode: "bigint",
    }),
    claimedFingerprint: p.text("claimed_fingerprint"),
    payload: p.text(),
    payloadHash: p.text("payload_hash"),
    provenance: jsonb().$type<EuCompletionProvenance>(),
    detail: p.text(),
    attempts: p.integer().default(0).notNull(),
    attemptState: p
      .text("attempt_state", { enum: ATTEMPT_STATES })
      .default("idle")
      .notNull(),
    systemicFailures: p.integer("systemic_failures").default(0).notNull(),
    systemicProgress: p
      .bigint("systemic_progress", { mode: "number" })
      .default(0)
      .notNull(),
    refusalCount: p.integer("refusal_count").default(0).notNull(),
    refusalProgress: p
      .bigint("refusal_progress", { mode: "number" })
      .default(0)
      .notNull(),
    refusalHoldUntil: timestamptz("refusal_hold_until"),
    mirrorWaits: p.integer("mirror_waits").default(0).notNull(),
    retryAt: timestamptz("retry_at"),
    writtenAt: timestamptz("written_at"),
    writtenSourceHash: p.text("written_source_hash"),
    writtenObservationOrder: p.bigint("written_observation_order", {
      mode: "bigint",
    }),
    writtenParserVersion: p.integer("written_parser_version"),
    supersededAt: timestamptz("superseded_at"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
    completedAt: timestamptz("completed_at"),
  },
  (t) => [
    p.primaryKey({ columns: [t.id], name: "eu_completion_receipts_pkey" }),
    p
      .unique("eu_completion_receipts_approval_proof_key")
      .on(t.id, t.sourceId, t.parserVersion, t.mode, t.status, t.completedAt),
    p
      .foreignKey({
        columns: [t.sourceId],
        foreignColumns: [caseLawSources.id],
        name: "eu_completion_receipts_source_fk",
      })
      .onDelete("restrict"),
    p
      .index("eu_completion_receipts_due_idx")
      .on(
        t.sourceId,
        t.mode,
        t.parserVersion,
        t.status,
        t.retryAt,
        t.decisionId,
      ),
    p
      .index("eu_completion_receipts_document_idx")
      .on(t.sourceId, t.decisionId, t.createdAt, t.id),
    p
      .index("eu_completion_receipts_retention_idx")
      .on(t.supersededAt, t.id)
      .where(sql`${t.supersededAt} IS NOT NULL`),
    p.check(
      "eu_completion_receipts_status_check",
      sql`${t.status} IN (${sql.join(
        EU_COMPLETION_STATUSES.map((v) => sql.raw(`'${v}'`)),
        sql`, `,
      )})`,
    ),
    p.check(
      "eu_completion_receipts_mode_check",
      sql`${t.mode} IN (${sql.join(
        EU_COMPLETION_MODES.map((v) => sql.raw(`'${v}'`)),
        sql`, `,
      )})`,
    ),
    p.check(
      "eu_completion_receipts_target_check",
      sql`${t.target} IS NULL OR ${t.target} IN (${sql.join(
        EU_COMPLETION_TARGETS.map((v) => sql.raw(`'${v}'`)),
        sql`, `,
      )})`,
    ),
    p.check(
      "eu_completion_receipts_attempt_state_check",
      sql`${t.attemptState} IN (${sql.join(
        ATTEMPT_STATES.map((v) => sql.raw(`'${v}'`)),
        sql`, `,
      )})`,
    ),
    p.check(
      "eu_completion_receipts_attempts_check",
      sql`${t.attempts} >= 0 AND ${t.parserVersion} >= 0 AND ${t.systemicFailures} >= 0 AND ${t.systemicProgress} >= 0 AND ${t.refusalCount} >= 0 AND ${t.refusalProgress} >= 0 AND ${t.mirrorWaits} >= 0`,
    ),
    p.check(
      "eu_completion_receipts_payload_check",
      sql`${t.payload} IS NULL OR octet_length(${t.payload}) <= ${EU_COMPLETION_PAYLOAD_MAX_BYTES}`,
    ),
    p.check(
      "eu_completion_receipts_provenance_check",
      sql`${t.provenance} IS NULL OR (jsonb_typeof(${t.provenance}) = 'object' AND octet_length(${t.provenance}::text) <= 32768)`,
    ),
    p.check(
      "eu_completion_receipts_fetched_check",
      sql`${t.status} <> 'fetched' OR (${t.payload} IS NOT NULL AND ${t.payloadHash} IS NOT NULL AND ${t.claimedFingerprint} IS NOT NULL AND ${t.target} IS NOT NULL)`,
    ),
    p.check(
      "eu_completion_receipts_retry_check",
      sql`${t.status} NOT IN (${sql.join(
        RETRY_STATUSES.map((value) => sql.raw(`'${value}'`)),
        sql`, `,
      )}) OR ${t.retryAt} IS NOT NULL`,
    ),
    p.check(
      "eu_completion_receipts_refusal_check",
      sql`${t.status} <> 'publisher-refused' OR (${t.completedAt} IS NULL AND ${t.retryAt} IS NOT NULL) OR (${t.completedAt} IS NOT NULL AND ${t.retryAt} IS NULL)`,
    ),
    p.check(
      "eu_completion_receipts_written_check",
      sql`${t.writtenAt} IS NULL OR (${t.mode} = 'apply' AND ${t.writtenParserVersion} IS NOT NULL AND ${t.writtenSourceHash} IS NOT NULL AND ${t.writtenObservationOrder} IS NOT NULL)`,
    ),
    p.pgPolicy("eu_completion_receipts_owner_access", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.eu_completion_receipts'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.eu_completion_receipts'::regclass)`,
    }),
  ],
);

export const euCompletionRequestHours = p.pgTable.withRLS(
  "eu_completion_request_hours",
  {
    hour: timestamptz("hour").notNull(),
    requests: p.integer().notNull(),
  },
  (t) => [
    p.primaryKey({
      columns: [t.hour],
      name: "eu_completion_request_hours_pkey",
    }),
    p.check(
      "eu_completion_request_hours_count_check",
      sql`${t.requests} >= 0 AND ${t.requests} <= ${EU_COMPLETION_REQUESTS_PER_HOUR}`,
    ),
    p.pgPolicy("eu_completion_request_hours_owner_access", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.eu_completion_request_hours'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.eu_completion_request_hours'::regclass)`,
    }),
  ],
);

// Approval is immutable per source/parser generation. Evidence receipts survive
// compaction through a restricted FK; approval never enables either control.
export const euCompletionApprovals = p.pgTable.withRLS(
  "eu_completion_approvals",
  {
    sourceId: safeUuid<"caseLawSource">("source_id").notNull(),
    parserVersion: p.integer("parser_version").notNull(),
    supervisedReceiptId: p.text("supervised_receipt_id").notNull(),
    evidenceRef: p.text("evidence_ref").notNull(),
    supervisedBy: p.text("supervised_by").notNull(),
    supervisedAt: timestamptz("supervised_at").notNull(),
    approvedBy: p.text("approved_by").notNull(),
    approvedAt: timestamptz("approved_at").notNull(),
    proofMode: p.text("proof_mode").notNull(),
    proofStatus: p.text("proof_status").notNull(),
    proofCompletedAt: timestamptz("proof_completed_at").notNull(),
    reviewedCounts: jsonb("reviewed_counts")
      .$type<EuCompletionReviewedCounts>()
      .notNull(),
  },
  (t) => [
    p.primaryKey({
      columns: [t.sourceId, t.parserVersion],
      name: "eu_completion_approvals_pkey",
    }),
    p
      .foreignKey({
        columns: [t.sourceId],
        foreignColumns: [caseLawSources.id],
        name: "eu_completion_approvals_source_fk",
      })
      .onDelete("restrict"),
    p
      .foreignKey({
        columns: [
          t.supervisedReceiptId,
          t.sourceId,
          t.parserVersion,
          t.proofMode,
          t.proofStatus,
          t.proofCompletedAt,
        ],
        foreignColumns: [
          euCompletionReceipts.id,
          euCompletionReceipts.sourceId,
          euCompletionReceipts.parserVersion,
          euCompletionReceipts.mode,
          euCompletionReceipts.status,
          euCompletionReceipts.completedAt,
        ],
        name: "eu_completion_approvals_receipt_fk",
      })
      .onDelete("restrict"),
    p.index("eu_completion_approvals_receipt_idx").on(t.supervisedReceiptId),
    p.check(
      "eu_completion_approvals_proof_check",
      sql`${t.proofMode} = 'dry-run' AND ${t.proofStatus} = 'dry-run' AND ${t.proofCompletedAt}::timestamptz <= ${t.supervisedAt}::timestamptz`,
    ),
    p.check(
      "eu_completion_approvals_reviewed_check",
      sql`jsonb_typeof(${t.reviewedCounts}) = 'object' AND jsonb_typeof(${t.reviewedCounts}->'reviewed') = 'number' AND jsonb_typeof(${t.reviewedCounts}->'accepted') = 'number' AND jsonb_typeof(${t.reviewedCounts}->'requiresReview') = 'number' AND (${t.reviewedCounts}->>'reviewed')::numeric BETWEEN 1 AND 1000000 AND (${t.reviewedCounts}->>'accepted')::numeric BETWEEN 0 AND 1000000 AND (${t.reviewedCounts}->>'requiresReview')::numeric BETWEEN 0 AND 1000000 AND (${t.reviewedCounts}->>'reviewed')::numeric = trunc((${t.reviewedCounts}->>'reviewed')::numeric) AND (${t.reviewedCounts}->>'accepted')::numeric = trunc((${t.reviewedCounts}->>'accepted')::numeric) AND (${t.reviewedCounts}->>'requiresReview')::numeric = trunc((${t.reviewedCounts}->>'requiresReview')::numeric) AND (${t.reviewedCounts}->>'accepted')::numeric + (${t.reviewedCounts}->>'requiresReview')::numeric = (${t.reviewedCounts}->>'reviewed')::numeric AND ${t.reviewedCounts} ?& ARRAY['reviewed','accepted','requiresReview']`,
    ),
    p.check(
      "eu_completion_approvals_evidence_check",
      sql`${t.parserVersion} >= 0 AND length(trim(${t.evidenceRef})) BETWEEN 1 AND 2048 AND length(trim(${t.supervisedBy})) BETWEEN 1 AND 128 AND length(trim(${t.approvedBy})) BETWEEN 1 AND 128 AND ${t.supervisedAt}::timestamptz <= ${t.approvedAt}::timestamptz`,
    ),
    p.pgPolicy("eu_completion_approvals_owner_access", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.eu_completion_approvals'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.eu_completion_approvals'::regclass)`,
    }),
  ],
);

export const euCompletionControls = p.pgTable.withRLS(
  "eu_completion_controls",
  {
    key: p.text().notNull(),
    sourceId: safeUuid<"caseLawSource">("source_id"),
    state: p
      .text({ enum: EU_COMPLETION_CONTROL_STATES })
      .default("off")
      .notNull(),
    batch: jsonb().$type<BatchState>(),
    cursor: safeUuid<"caseLawDecision">("cursor"),
    completedRows: p
      .bigint("completed_rows", { mode: "number" })
      .default(0)
      .notNull(),
    healthyRows: p
      .bigint("healthy_rows", { mode: "number" })
      .default(0)
      .notNull(),
    ticksWithoutProgress: p
      .integer("ticks_without_progress")
      .default(0)
      .notNull(),
    lastCompletedAt: timestamptz("last_completed_at"),
    changedBy: p.text("changed_by"),
    changedAt: timestamptz("changed_at"),
  },
  (t) => [
    p.primaryKey({ columns: [t.key], name: "eu_completion_controls_pkey" }),
    p
      .foreignKey({
        columns: [t.sourceId],
        foreignColumns: [caseLawSources.id],
        name: "eu_completion_controls_source_fk",
      })
      .onDelete("restrict"),
    p.check(
      "eu_completion_controls_state_check",
      sql`${t.state} IN (${sql.join(
        EU_COMPLETION_CONTROL_STATES.map((v) => sql.raw(`'${v}'`)),
        sql`, `,
      )})`,
    ),
    p.check(
      "eu_completion_controls_operator_check",
      sql`${t.state} <> 'on' OR (${t.changedBy} IS NOT NULL AND length(trim(${t.changedBy})) BETWEEN 1 AND 128 AND ${t.changedAt} IS NOT NULL)`,
    ),
    p.check(
      "eu_completion_controls_counts_check",
      sql`${t.completedRows} >= 0 AND ${t.healthyRows} >= 0 AND ${t.ticksWithoutProgress} >= 0`,
    ),
    p.pgPolicy("eu_completion_controls_owner_access", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.eu_completion_controls'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.eu_completion_controls'::regclass)`,
    }),
  ],
);
