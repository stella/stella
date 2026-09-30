import type {
  AssessmentReason,
  PayloadAssessment,
} from "@/api/lib/legal-search/text-retention/validation";

import { caseLawDecisions, caseLawSources } from "./case-law";
import {
  globalCaseLawPolicies,
  jsonb,
  p,
  publicLawReaderPolicies,
  safeUuid,
  sql,
  timestamptz,
} from "./common";

export const TEXT_RETENTION_STATUSES = {
  assessed: "assessed",
  empty_source: "empty_source",
  unavailable: "unavailable",
} as const satisfies {
  [Status in PayloadAssessment["verdict"]["status"]]: Status;
};

const ASSESSMENT_REASONS = {
  unavailable: "unavailable",
  malformed: "malformed",
  unsupported: "unsupported",
  resource_limit: "resource_limit",
  no_text_layer: "no_text_layer",
  no_raw: "no_raw",
  composite_unreverifiable: "composite_unreverifiable",
  ambiguous_component: "ambiguous_component",
  missing_output: "missing_output",
  unknown_source: "unknown_source",
  raw_mismatch: "raw_mismatch",
  payload_mismatch: "payload_mismatch",
  raw_read_failed: "raw_read_failed",
  payload_read_failed: "payload_read_failed",
  missing_snapshot: "missing_snapshot",
  source_mismatch: "source_mismatch",
} as const satisfies { [Reason in AssessmentReason]: Reason };

/** One snapshot per decision; object addresses and component diagnostics remain operational. */
export const caseLawTextRetentionVerdicts = p.pgTable.withRLS(
  "case_law_text_retention_verdicts",
  {
    decisionId: safeUuid<"caseLawDecision">("decision_id")
      .primaryKey()
      .references(() => caseLawDecisions.id, { onDelete: "cascade" }),
    sourceId: safeUuid<"caseLawSource">("source_id")
      .notNull()
      .references(() => caseLawSources.id, { onDelete: "cascade" }),
    rawS3Key: p.text("raw_s3_key"),
    rawFingerprint: p.varchar("raw_fingerprint", { length: 64 }),
    payloadFingerprint: p
      .varchar("payload_fingerprint", { length: 64 })
      .notNull(),
    compositionFingerprint: p
      .varchar("composition_fingerprint", { length: 64 })
      .notNull(),
    sourceHash: p.varchar("source_hash", { length: 64 }),
    parserVersion: p.integer("parser_version").notNull(),
    oracleVersion: p.integer("oracle_version").notNull(),
    exclusionVersion: p.integer("exclusion_version").notNull(),
    checkedAt: timestamptz("checked_at").defaultNow().notNull(),
    status: p.text({ enum: Object.values(TEXT_RETENTION_STATUSES) }).notNull(),
    retainedRatio: p.doublePrecision("retained_ratio"),
    defect: p.text({ enum: ["text_loss_suspected"] }),
    reason: p.text({ enum: Object.values(ASSESSMENT_REASONS) }),
    missingSampleHash: p.varchar("missing_sample_hash", { length: 64 }),
    components: jsonb("components")
      .$type<PayloadAssessment["components"]>()
      .notNull(),
  },
  (t) => [
    p
      .index("case_law_text_retention_source_decision_idx")
      .on(t.sourceId, t.decisionId),
    p.check(
      "case_law_text_retention_status_shape",
      sql`CASE ${t.status} WHEN 'assessed' THEN ${t.retainedRatio} IS NOT NULL AND ${t.retainedRatio} >= 0 AND ${t.retainedRatio} <= 1 AND ${t.reason} IS NULL AND (${t.defect} IS NULL OR ${t.defect} = 'text_loss_suspected') WHEN 'empty_source' THEN ${t.retainedRatio} IS NULL AND ${t.defect} IS NULL AND ${t.reason} IS NULL AND ${t.missingSampleHash} IS NULL WHEN 'unavailable' THEN ${t.retainedRatio} IS NULL AND ${t.defect} IS NULL AND ${t.reason} IS NOT NULL AND ${t.missingSampleHash} IS NULL ELSE false END`,
    ),
    p.check(
      "case_law_text_retention_versions",
      sql`${t.parserVersion} >= 0 AND ${t.oracleVersion} > 0 AND ${t.exclusionVersion} > 0`,
    ),
    p.check(
      "case_law_text_retention_fingerprints",
      sql`${t.payloadFingerprint} ~ '^[0-9a-f]{64}$' AND ${t.compositionFingerprint} ~ '^[0-9a-f]{64}$' AND (${t.rawFingerprint} IS NULL OR ${t.rawFingerprint} ~ '^[0-9a-f]{64}$') AND (${t.sourceHash} IS NULL OR ${t.sourceHash} ~ '^[0-9a-f]{64}$') AND (${t.missingSampleHash} IS NULL OR ${t.missingSampleHash} ~ '^[0-9a-f]{64}$')`,
    ),
    p.check(
      "case_law_text_retention_components",
      sql`jsonb_typeof(${t.components}) = 'array'`,
    ),
    p.check(
      "case_law_text_retention_reason_values",
      sql`${t.reason} IS NULL OR ${t.reason} IN (${sql.join(
        Object.values(ASSESSMENT_REASONS).map((reason) =>
          sql.raw(`'${reason}'`),
        ),
        sql.raw(", "),
      )})`,
    ),
    ...globalCaseLawPolicies(),
    ...publicLawReaderPolicies(),
    // FORCE RLS also applies to deployment owners; table privileges remain the access boundary.
    p.pgPolicy("case_law_text_retention_owner_access", {
      for: "all",
      to: "public",
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
);
