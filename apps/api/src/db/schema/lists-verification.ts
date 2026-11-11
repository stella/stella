import { FACT_DATE_PRECISIONS } from "@/api/lib/lists/fact-details";
import {
  CLAIM_ANCHOR_TYPES,
  CLAIM_ASSERTED_ON_SOURCES,
  CLAIM_CARRY_OUTCOMES,
  CLAIM_DATE_SOURCES,
  CLAIM_FRAMINGS,
  CLAIM_REVIEW_EVENT_KINDS,
  CLAIM_REVIEW_REASON_RULE,
  CLAIM_STATE,
  CLAIM_STATES,
  CLAIM_TYPES,
  MATCHED_CLAIM_CARRY_OUTCOMES,
  PARAGRAPH_NUMBERINGS,
  SCORED_CLAIM_STATES,
  VERIFICATION_LIMITS,
  VERIFICATION_RUN_ACTIVE_STATUSES,
  VERIFICATION_RUN_ERROR_CODES,
  VERIFICATION_RUN_STATUSES,
  WHOLE_DOCUMENT_SCOPE,
} from "@/api/lib/lists/verification/contract";
import type {
  ClaimAnchor,
  ClaimRef,
  ClaimReviewEventPayload,
  ClaimReviewReasonRule,
  RecordConflict,
  VerificationEvidence,
  VerificationScope,
} from "@/api/lib/lists/verification/contract";
import type { GraderClaimQualifier } from "@/api/lib/lists/verification/qualifiers";
import { DEFAULT_VERIFICATION_RUN_CAPS } from "@/api/lib/lists/verification/run-cap-config";

import {
  entityFeatureGateChecks,
  entityFeatureGateColumns,
  entityFeatureOrganizationGateColumns,
} from "../entity-feature-gate-columns";
import { entityFeaturePolicies } from "../entity-feature-policies";
import {
  jsonb,
  organization,
  orgPolicies,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  sql,
  stella,
  timestamptz,
  user,
  workspaceCheck,
  wsOrganizationPolicies,
  wsOrganizationUserPolicies,
  wsPolicies,
} from "./common";
import { workspaces } from "./contacts";
import { entities } from "./entities";

const quoted = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql`, `,
  );

const CLAIM_ANCHOR_TYPE_SQL_VALUES = quoted(CLAIM_ANCHOR_TYPES);
const RUN_STATUS_SQL_VALUES = quoted(VERIFICATION_RUN_STATUSES);
const RUN_ERROR_CODE_SQL_VALUES = quoted(VERIFICATION_RUN_ERROR_CODES);
const RUN_ACTIVE_STATUS_SQL_VALUES = quoted(VERIFICATION_RUN_ACTIVE_STATUSES);
const CLAIM_TYPE_SQL_VALUES = quoted(CLAIM_TYPES);
const CLAIM_FRAMING_SQL_VALUES = quoted(CLAIM_FRAMINGS);
const CLAIM_STATE_SQL_VALUES = quoted(CLAIM_STATES);
const SCORED_CLAIM_STATE_SQL_VALUES = quoted(SCORED_CLAIM_STATES);
const REVIEW_EVENT_KIND_SQL_VALUES = quoted(CLAIM_REVIEW_EVENT_KINDS);
const CARRY_OUTCOME_SQL_VALUES = quoted(CLAIM_CARRY_OUTCOMES);
const MATCHED_CARRY_OUTCOME_SQL_VALUES = quoted(MATCHED_CLAIM_CARRY_OUTCOMES);
const reviewKindsWhereReason = (rules: readonly ClaimReviewReasonRule[]) =>
  quoted(
    CLAIM_REVIEW_EVENT_KINDS.filter((kind) =>
      rules.includes(CLAIM_REVIEW_REASON_RULE[kind]),
    ),
  );
const REASON_REQUIRED_KIND_SQL_VALUES = reviewKindsWhereReason(["required"]);
const REASON_ALLOWED_KIND_SQL_VALUES = reviewKindsWhereReason([
  "required",
  "optional",
]);
const ASSERTED_ON_SOURCE_SQL_VALUES = quoted(CLAIM_ASSERTED_ON_SOURCES);
const DATED_SOURCE_SQL_VALUES = quoted(CLAIM_DATE_SOURCES);
const DATE_PRECISION_SQL_VALUES = quoted(FACT_DATE_PRECISIONS);
const NOTE_MAX_SQL = sql.raw(String(VERIFICATION_LIMITS.NOTE_MAX));
const NOTVERIFIABLE_SQL = sql.raw(`'${CLAIM_STATE.NOTVERIFIABLE}'`);
const RECORDCONFLICT_SQL = sql.raw(`'${CLAIM_STATE.RECORDCONFLICT}'`);
const NOCOVER_SQL = sql.raw(`'${CLAIM_STATE.NOCOVER}'`);
const RECORD_SILENT_SQL = sql.raw(
  `'${"record-silent" satisfies GraderClaimQualifier["kind"]}'`,
);
const PARAGRAPH_NUMBERING_SQL_VALUES = quoted(PARAGRAPH_NUMBERINGS);
const WHOLE_DOCUMENT_SCOPE_SQL = sql.raw(
  `'${JSON.stringify(WHOLE_DOCUMENT_SCOPE)}'::jsonb`,
);

const verificationBudgetOwner = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
  FROM pg_catalog.pg_class WHERE oid = 'public.legal_list_verification_budgets'::regclass)`;

export const legalListVerificationBudgets = p.pgTable.withRLS(
  "legal_list_verification_budgets",
  {
    organizationId: safeOrganizationId("organization_id").primaryKey(),
    activeRuns: p.integer("active_runs").notNull().default(0),
    startsDay: p
      .date("starts_day", { mode: "string" })
      .notNull()
      .default(sql`stella_list_verification_day(CURRENT_TIMESTAMP)`),
    startsToday: p.integer("starts_today").notNull().default(0),
    activeLimit: p
      .integer("active_limit")
      .notNull()
      .default(DEFAULT_VERIFICATION_RUN_CAPS.active),
    dailyLimit: p
      .integer("daily_limit")
      .notNull()
      .default(DEFAULT_VERIFICATION_RUN_CAPS.startsPerDay),
  },
  (table) => [
    ...orgPolicies(),
    p
      .foreignKey({
        name: "legal_list_verification_budgets_org_fk",
        columns: [table.organizationId],
        foreignColumns: [organization.id],
      })
      .onDelete("cascade"),
    p.pgPolicy("legal_list_verification_budgets_owner_access", {
      for: "all",
      to: "public",
      using: verificationBudgetOwner,
      withCheck: verificationBudgetOwner,
    }),
    p.pgPolicy("legal_list_verification_budgets_no_delete", {
      as: "restrictive",
      for: "delete",
      to: stella,
      using: sql`false`,
    }),
    p.check(
      "legal_list_verification_budgets_nonnegative",
      sql`${table.activeRuns} >= 0 AND ${table.startsToday} >= 0`,
    ),
    p.check(
      "legal_list_verification_budgets_limits",
      sql`${table.activeLimit} BETWEEN 1 AND 100 AND ${table.dailyLimit} BETWEEN 1 AND 1000`,
    ),
  ],
);

/**
 * One immutable verification of a document against a matter's anchor facts.
 *
 * The target and the evidence are pinned by value: `evidence` embeds every
 * fact the run read. History survives list edits and document versions;
 * deleting the document or its workspace cascades the pinned content.
 */
export const legalListVerificationRuns = p.pgTable(
  "legal_list_verification_runs",
  {
    ...entityFeatureGateColumns(),
    id: pUuid<"legalListVerificationRun">().primaryKey(),
    // The worker rebuilds its tenant scope from the row, so the organization
    // is recorded rather than looked up.
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Version and field pins survive edits; the document owns the run lifecycle.
    entityId: safeUuid<"entity">("entity_id").notNull(),
    fileFieldId: safeUuid<"field">("file_field_id").notNull(),
    entityVersionId: safeUuid<"entityVersion">("entity_version_id").notNull(),
    contentSha256: p.varchar("content_sha256", { length: 64 }).notNull(),
    evidence: jsonb().$type<VerificationEvidence>().notNull(),
    // What the run checks: the whole document, or a paragraph range
    // resolved when the run started (contract.ts `VerificationScope`).
    scope: jsonb()
      .$type<VerificationScope>()
      .notNull()
      .default(sql`${WHOLE_DOCUMENT_SCOPE_SQL}`),
    status: p
      .text("status", { enum: VERIFICATION_RUN_STATUSES })
      .notNull()
      .default("queued"),
    errorCode: p.text("error_code", { enum: VERIFICATION_RUN_ERROR_CODES }),
    requestedBy: p
      .text("requested_by")
      .references(() => user.id, { onDelete: "set null" }),
    // Bumped when the engine changes shape, so an old run is never read as if
    // today's engine had produced it.
    pipelineVersion: p.integer("pipeline_version").notNull().default(1),
    modelRef: p.varchar("model_ref", { length: 256 }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
  },
  (table) => [
    ...entityFeatureGateChecks(table),
    ...entityFeaturePolicies(
      table,
      new Map([
        [table.entityId, { target: "entities", kind: "owned-content" }],
      ]),
    ),
    p
      .foreignKey({
        name: "legal_list_verification_runs_entity_fk",
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
      })
      .onDelete("cascade"),
    p
      .unique("legal_list_verification_runs_id_ws_unq")
      .on(table.id, table.workspaceId),
    p
      .index("legal_list_verification_runs_document_created_idx")
      .on(
        table.workspaceId,
        table.entityId,
        table.fileFieldId,
        table.createdAt.desc(),
        table.id.desc(),
      ),
    // The latest finished run of each document checked against a list, for
    // the list's verification graph, without reading the pinned evidence of
    // every run. Built online (indexes-legal-list-verification-runs-list-
    // document-idx).
    p
      .index("legal_list_verification_runs_list_document_idx")
      .on(
        table.workspaceId,
        sql`(${table.evidence} ->> 'listId')`,
        table.entityId,
        table.fileFieldId,
        table.createdAt.desc(),
        table.id.desc(),
      )
      .where(sql`${table.status} = 'completed'`),
    // At most one unfinished run per document; makes a lost race impossible.
    p
      .uniqueIndex("legal_list_verification_runs_active_document_uidx")
      .on(table.workspaceId, table.entityId, table.fileFieldId)
      .where(sql`${table.status} IN (${RUN_ACTIVE_STATUS_SQL_VALUES})`),
    // The reconciler's keyset walk over runs still waiting for a worker.
    p
      .index("legal_list_verification_runs_queued_idx")
      .on(table.createdAt, table.id)
      .where(sql`${table.status} = 'queued'`),
    p.check(
      "legal_list_verification_runs_status_check",
      sql`${table.status} IN (${RUN_STATUS_SQL_VALUES})`,
    ),
    // A failed run always says why, and no other run carries a reason.
    p.check(
      "legal_list_verification_runs_error_code_check",
      sql`(${table.status} = 'failed') = (${table.errorCode} IS NOT NULL)
        AND (${table.errorCode} IS NULL OR ${table.errorCode} IN (${RUN_ERROR_CODE_SQL_VALUES}))`,
    ),
    p.check(
      "legal_list_verification_runs_content_hash_check",
      sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    p.check(
      "legal_list_verification_runs_evidence_shape_check",
      sql`jsonb_typeof(${table.evidence}->'facts') = 'array'
        AND jsonb_typeof(${table.evidence}->'listId') = 'string'`,
    ),
    p.check(
      "legal_list_verification_runs_pipeline_version_check",
      sql`${table.pipelineVersion} > 0`,
    ),
    // A whole-document scope carries nothing else; a paragraph range names
    // an inclusive range from 1, how it counted, and the two edges it
    // resolved to.
    p.check(
      "legal_list_verification_runs_scope_check",
      sql`CASE ${table.scope}->>'kind'
        WHEN 'whole' THEN ${table.scope} = ${WHOLE_DOCUMENT_SCOPE_SQL}
        WHEN 'paragraphs' THEN CASE
          WHEN jsonb_typeof(${table.scope}->'from') = 'number'
            AND jsonb_typeof(${table.scope}->'to') = 'number'
            AND jsonb_typeof(${table.scope}->'start'->'blockId') = 'string'
            AND jsonb_typeof(${table.scope}->'start'->'offset') = 'number'
            AND jsonb_typeof(${table.scope}->'end'->'blockId') = 'string'
            AND jsonb_typeof(${table.scope}->'end'->'offset') = 'number'
            AND jsonb_typeof(${table.scope}->'numbering') = 'string'
          THEN (${table.scope}->>'from')::numeric >= 1
            AND (${table.scope}->>'to')::numeric >= (${table.scope}->>'from')::numeric
            AND ${table.scope}->>'numbering' IN (${PARAGRAPH_NUMBERING_SQL_VALUES})
          ELSE false END
        ELSE false END`,
    ),
    // The worker rebuilds its tenant scope from this row, so the organization
    // is held to the workspace's own, and both scopes gate every command.
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "legal_list_verification_runs_workspace_organization_fk",
      })
      .onDelete("cascade"),
    ...wsOrganizationPolicies("legal_list_verification_runs", {
      columns: table,
    }),
    p.pgPolicy("legal_list_verification_runs_owner_access", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
        FROM pg_catalog.pg_class WHERE oid = 'public.legal_list_verification_runs'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
        FROM pg_catalog.pg_class WHERE oid = 'public.legal_list_verification_runs'::regclass)`,
    }),
  ],
);

/** One durable receipt per reader/run; the audit log retains the daily events. */
export const legalListVerificationReadReceipts = p.pgTable(
  "legal_list_verification_read_receipts",
  {
    ...entityFeatureGateColumns(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    runId: safeUuid<"legalListVerificationRun">("run_id").notNull(),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    auditedDay: p.date("audited_day", { mode: "string" }).notNull(),
  },
  (table) => [
    ...entityFeatureGateChecks(table),
    p.primaryKey({
      name: "verification_read_receipts_pk",
      columns: [
        table.organizationId,
        table.workspaceId,
        table.runId,
        table.userId,
      ],
    }),
    p
      .foreignKey({
        name: "verification_read_receipts_run_fk",
        columns: [table.runId, table.workspaceId],
        foreignColumns: [
          legalListVerificationRuns.id,
          legalListVerificationRuns.workspaceId,
        ],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "verification_read_receipts_workspace_org_fk",
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
      })
      .onDelete("cascade"),
    p
      .index("verification_read_receipts_run_idx")
      .on(table.workspaceId, table.runId),
    p.index("verification_read_receipts_user_idx").on(table.userId),
    ...entityFeaturePolicies(
      table,
      new Map([
        [
          table.runId,
          { kind: "owned-by-parent", parent: legalListVerificationRuns },
        ],
      ]),
    ),
    ...wsOrganizationUserPolicies("legal_list_verification_read_receipts"),
  ],
);

/** Exact source text read by the engine, pinned with the run. */
export const legalListVerificationBlocks = p.pgTable(
  "legal_list_verification_blocks",
  {
    ...entityFeatureGateColumns(),
    ...entityFeatureOrganizationGateColumns(),
    runId: safeUuid<"legalListVerificationRun">("run_id").notNull(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    ordinal: p.smallint().notNull(),
    blockId: p.text("block_id").notNull(),
    kind: p.text("kind", { enum: CLAIM_ANCHOR_TYPES }).notNull(),
    pageNumber: p.integer("page_number"),
    text: p.text().notNull(),
  },
  (table) => [
    ...entityFeatureGateChecks(table),
    p.primaryKey({ columns: [table.runId, table.ordinal] }),
    p
      .foreignKey({
        name: "legal_list_verification_blocks_run_fk",
        columns: [table.runId, table.workspaceId],
        foreignColumns: [
          legalListVerificationRuns.id,
          legalListVerificationRuns.workspaceId,
        ],
      })
      .onDelete("cascade"),
    p
      .index("legal_list_verification_blocks_run_idx")
      .on(table.workspaceId, table.runId, table.ordinal),
    p.check(
      "legal_list_verification_blocks_ordinal_check",
      sql`${table.ordinal} >= 0 AND ${table.ordinal} < ${sql.raw(String(VERIFICATION_LIMITS.BLOCKS_PER_RUN_MAX))}`,
    ),
    p.check(
      "legal_list_verification_blocks_kind_check",
      sql`${table.kind} IN (${CLAIM_ANCHOR_TYPE_SQL_VALUES})`,
    ),
    p.check(
      "legal_list_verification_blocks_page_check",
      sql`(${table.kind} = 'docx-block' AND ${table.pageNumber} IS NULL)
        OR (${table.kind} = 'pdf-page' AND ${table.pageNumber} > 0)`,
    ),
    ...wsPolicies({
      columns: table,
      references: new Map([
        [
          table.runId,
          { kind: "owned-by-parent", parent: legalListVerificationRuns },
        ],
      ]),
    }),
  ],
);

/**
 * One claim the engine found in the run's document, with its verdict.
 * Immutable once written: reviewer dispositions live in
 * `legal_list_claim_review_events`, never on this row.
 */
export const legalListClaims = p.pgTable(
  "legal_list_claims",
  {
    ...entityFeatureGateColumns(),
    ...entityFeatureOrganizationGateColumns(),
    id: pUuid<"legalListClaim">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    runId: safeUuid<"legalListVerificationRun">("run_id").notNull(),
    // Reading order in the document; also the engine's upsert key, so a
    // re-delivered job converges on the rows it already wrote.
    position: p.integer().notNull(),
    type: p.text("type", { enum: CLAIM_TYPES }).notNull(),
    framing: p
      .text("framing", { enum: CLAIM_FRAMINGS })
      .notNull()
      .default("asserted"),
    state: p.text("state", { enum: CLAIM_STATES }).notNull(),
    score: p.smallint(),
    text: p.varchar({ length: VERIFICATION_LIMITS.CLAIM_TEXT_MAX }).notNull(),
    anchor: jsonb().$type<ClaimAnchor>().notNull(),
    refs: jsonb().$type<ClaimRef[]>().notNull().default([]),
    recordConflict: jsonb("record_conflict").$type<RecordConflict>(),
    // Caveats the grader gave with the verdict. Qualifiers computed from the
    // facts as they stand now are never stored.
    qualifiers: jsonb().$type<GraderClaimQualifier[]>().notNull().default([]),
    // The date the claim asserts for what it says (`claim-date.ts`), stored
    // as its first day like a fact's; null when it gives none. A re-check
    // records its own reading; the run's stays here.
    assertedOn: p.date("asserted_on", { mode: "string" }),
    assertedOnPrecision: p.text("asserted_on_precision", {
      enum: FACT_DATE_PRECISIONS,
    }),
    // Where the date came from, or `none`; `pending` only on claims written
    // before claims carried dates, until the backfill reads their words.
    assertedOnSource: p
      .text("asserted_on_source", { enum: CLAIM_ASSERTED_ON_SOURCES })
      .notNull()
      .default("pending"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    ...entityFeatureGateChecks(table),
    p
      .foreignKey({
        name: "legal_list_claims_run_fk",
        columns: [table.runId, table.workspaceId],
        foreignColumns: [
          legalListVerificationRuns.id,
          legalListVerificationRuns.workspaceId,
        ],
      })
      .onDelete("cascade"),
    p
      .unique("legal_list_claims_id_run_ws_unq")
      .on(table.id, table.runId, table.workspaceId),
    p
      .uniqueIndex("legal_list_claims_run_position_uidx")
      .on(table.runId, table.position),
    p
      .index("legal_list_claims_run_idx")
      .on(table.workspaceId, table.runId, table.position),
    // The claims the asserted date backfill has yet to read: its batches and
    // its completion check, which every startup runs, read only these.
    p
      .index("legal_list_claims_asserted_on_pending_idx")
      .on(table.id)
      .where(sql`${table.assertedOnSource} = 'pending'`),
    p.check(
      "legal_list_claims_type_check",
      sql`${table.type} IN (${CLAIM_TYPE_SQL_VALUES})`,
    ),
    p.check(
      "legal_list_claims_framing_check",
      sql`${table.framing} IN (${CLAIM_FRAMING_SQL_VALUES})`,
    ),
    p.check(
      "legal_list_claims_state_check",
      sql`${table.state} IN (${CLAIM_STATE_SQL_VALUES})`,
    ),
    // A scored state always carries a real 0-100 score, an unscored one never
    // does: a verdict can never display beside a score computed for another.
    p.check(
      "legal_list_claims_score_check",
      sql`(${table.state} IN (${SCORED_CLAIM_STATE_SQL_VALUES})) = (${table.score} IS NOT NULL)
        AND (${table.score} IS NULL OR ${table.score} BETWEEN 0 AND 100)`,
    ),
    // Only a fact is checkable; an opinion or an unverifiable statement is set
    // aside, and a fact is never.
    p.check(
      "legal_list_claims_type_state_check",
      sql`(${table.type} = 'fact') = (${table.state} <> ${NOTVERIFIABLE_SQL})`,
    ),
    p.check(
      "legal_list_claims_record_conflict_check",
      sql`(${table.state} = ${RECORDCONFLICT_SQL}) = (${table.recordConflict} IS NOT NULL)`,
    ),
    p.check(
      "legal_list_claims_refs_shape_check",
      sql`jsonb_typeof(${table.refs}) = 'array'`,
    ),
    // Only missing coverage can be explained by a record that is not
    // expected to speak to the point.
    p.check(
      "legal_list_claims_qualifiers_check",
      sql`jsonb_typeof(${table.qualifiers}) = 'array'
        AND (${table.state} = ${NOCOVER_SQL}
          OR NOT ${table.qualifiers} @> jsonb_build_array(jsonb_build_object('kind', ${RECORD_SILENT_SQL})))`,
    ),
    // A date exactly when one was read, stated once: with its precision, as
    // its first day, so August 2021 has one spelling.
    p.check(
      "legal_list_claims_asserted_on_check",
      sql`${table.assertedOnSource} IN (${ASSERTED_ON_SOURCE_SQL_VALUES})
        AND (${table.assertedOn} IS NULL) = (${table.assertedOnPrecision} IS NULL)
        AND (${table.assertedOn} IS NOT NULL) = (${table.assertedOnSource} IN (${DATED_SOURCE_SQL_VALUES}))
        AND (${table.assertedOnPrecision} IS NULL OR ${table.assertedOnPrecision} IN (${DATE_PRECISION_SQL_VALUES}))
        AND (${table.assertedOnPrecision} IS NULL OR ${table.assertedOnPrecision} = 'day'
          OR (extract(day from ${table.assertedOn}) = 1
            AND (${table.assertedOnPrecision} = 'month' OR extract(month from ${table.assertedOn}) = 1)))`,
    ),
    p.check(
      "legal_list_claims_anchor_shape_check",
      sql`${table.anchor}->>'type' IN (${CLAIM_ANCHOR_TYPE_SQL_VALUES})`,
    ),
    // Positions are dense from 0, so this caps claims per run and keeps a
    // run's review read bounded.
    p.check(
      "legal_list_claims_position_check",
      sql`${table.position} >= 0 AND ${table.position} < ${sql.raw(String(VERIFICATION_LIMITS.CLAIMS_PER_RUN_MAX))}`,
    ),
    ...wsPolicies({
      columns: table,
      references: new Map([
        [
          table.runId,
          { kind: "owned-by-parent", parent: legalListVerificationRuns },
        ],
      ]),
    }),
    // The online backfill of asserted dates reads every workspace's claims
    // as the table owner.
    p.pgPolicy("legal_list_claims_owner_access", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
        FROM pg_catalog.pg_class WHERE oid = 'public.legal_list_claims'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner)
        FROM pg_catalog.pg_class WHERE oid = 'public.legal_list_claims'::regclass)`,
    }),
  ],
);

/**
 * Reviewer actions on a claim, append-only. The current review is the fold
 * of these rows in `created_at, id` order (`lib/lists/verification/review-fold.ts`); there
 * is no projection table to drift from them.
 */
export const legalListClaimReviewEvents = p.pgTable(
  "legal_list_claim_review_events",
  {
    ...entityFeatureGateColumns(),
    ...entityFeatureOrganizationGateColumns(),
    id: pUuid<"legalListClaimReviewEvent">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    runId: safeUuid<"legalListVerificationRun">("run_id").notNull(),
    claimId: safeUuid<"legalListClaim">("claim_id").notNull(),
    kind: p.text("kind", { enum: CLAIM_REVIEW_EVENT_KINDS }).notNull(),
    // Typed as written now, so a writer cannot leave out a required reason.
    // Rows from before reasons were required lack one: readers that report
    // reasons widen to `StoredClaimReviewEventPayload` (`reviewReasonOf`).
    payload: jsonb().$type<ClaimReviewEventPayload>().notNull(),
    actorId: p
      .text("actor_id")
      .references(() => user.id, { onDelete: "set null" }),
    // The insert's own clock, not the transaction's start: events are folded
    // in this order, and a reviewer whose transaction began earlier but took
    // the claim's lock later must still sort after the event they saw. A
    // carried event keeps its origin's time, so it folds in the order the
    // reviewer acted and before anything done on the new run.
    createdAt: timestamptz("created_at")
      .notNull()
      .default(sql`clock_timestamp()`),
    // A decision carried from the previous run of the document: the run and
    // the event it copies. Null for an action taken on this run.
    carriedFromRunId: safeUuid<"legalListVerificationRun">(
      "carried_from_run_id",
    ),
    carriedFromEventId: safeUuid<"legalListClaimReviewEvent">(
      "carried_from_event_id",
    ),
  },
  (table) => [
    ...entityFeatureGateChecks(table),
    p
      .foreignKey({
        name: "legal_list_claim_review_events_claim_fk",
        columns: [table.claimId, table.runId, table.workspaceId],
        foreignColumns: [
          legalListClaims.id,
          legalListClaims.runId,
          legalListClaims.workspaceId,
        ],
      })
      .onDelete("cascade"),
    p
      .index("legal_list_claim_review_events_run_created_idx")
      .on(table.workspaceId, table.runId, table.createdAt, table.id),
    p.check(
      "legal_list_claim_review_events_kind_check",
      sql`${table.kind} IN (${REVIEW_EVENT_KIND_SQL_VALUES})`,
    ),
    // The column is the indexed copy of the payload's discriminator; the two
    // can never name different events.
    p.check(
      "legal_list_claim_review_events_payload_kind_check",
      sql`${table.payload}->>'kind' = ${table.kind}`,
    ),
    // A reason, when given, is text with something besides spaces in it;
    // actions that change the verdict must give one. Added NOT VALID and
    // never validated: events recorded before reasons were required keep
    // their payload as written and read back as "no reason recorded". A
    // carried event is a copy of one of those as written, so it may lack a
    // reason its kind now requires.
    p.check(
      "legal_list_claim_review_events_reason_check",
      sql`CASE WHEN ${table.payload}->'reason' IS NULL
        THEN ${table.kind} NOT IN (${REASON_REQUIRED_KIND_SQL_VALUES})
          OR ${table.carriedFromEventId} IS NOT NULL
        ELSE ${table.kind} IN (${REASON_ALLOWED_KIND_SQL_VALUES})
          AND jsonb_typeof(${table.payload}->'reason') = 'string'
          AND char_length(btrim(${table.payload}->>'reason')) BETWEEN 1 AND ${NOTE_MAX_SQL}
        END`,
    ),
    ...entityFeaturePolicies(
      table,
      new Map([
        [table.claimId, { kind: "owned-by-parent", parent: legalListClaims }],
      ]),
    ),
    p.pgPolicy("workspace_select", {
      for: "select",
      to: stella,
      using: workspaceCheck,
    }),
    p.pgPolicy("workspace_insert", {
      for: "insert",
      to: stella,
      withCheck: workspaceCheck,
    }),
    p.pgPolicy("legal_list_claim_review_events_no_update", {
      as: "restrictive",
      for: "update",
      to: stella,
      using: sql`false`,
    }),
    p.pgPolicy("legal_list_claim_review_events_no_delete", {
      as: "restrictive",
      for: "delete",
      to: stella,
      using: sql`false`,
    }),
    p
      .index("legal_list_claim_review_events_ef_claim_id_idx")
      .on(table.workspaceId, table.claimId),
    // A carried event names both its origin run and its origin event.
    p.check(
      "legal_list_claim_review_events_carried_from_check",
      sql`(${table.carriedFromRunId} IS NULL) = (${table.carriedFromEventId} IS NULL)`,
    ),
  ],
);

/**
 * What became of each reviewed claim of the previous run of a document when
 * the next run completed (`lib/lists/verification/carry-over.ts`): carried to
 * a matching claim, matched but with decisions withdrawn because the verdict
 * changed, or left behind (no match, or more than one). Written once, with
 * the carried events, in the transaction that completes the run; the
 * previous run is never changed.
 */
export const legalListClaimCarryOutcomes = p.pgTable(
  "legal_list_claim_carry_outcomes",
  {
    ...entityFeatureGateColumns(),
    ...entityFeatureOrganizationGateColumns(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    // The run the decisions were carried to.
    runId: safeUuid<"legalListVerificationRun">("run_id").notNull(),
    sourceRunId:
      safeUuid<"legalListVerificationRun">("source_run_id").notNull(),
    sourceClaimId: safeUuid<"legalListClaim">("source_claim_id").notNull(),
    outcome: p.text("outcome", { enum: CLAIM_CARRY_OUTCOMES }).notNull(),
    // The matching claim of this run; null when nothing matched.
    targetClaimId: safeUuid<"legalListClaim">("target_claim_id"),
  },
  (table) => [
    ...entityFeatureGateChecks(table),
    // One outcome per source claim: a replayed completion carries nothing
    // twice.
    p.primaryKey({
      name: "legal_list_claim_carry_outcomes_pkey",
      columns: [table.runId, table.sourceClaimId],
    }),
    // And one source claim per target claim, so no claim receives two
    // claims' decisions.
    p
      .unique("legal_list_claim_carry_outcomes_target_unq")
      .on(table.runId, table.targetClaimId),
    p
      .foreignKey({
        name: "legal_list_claim_carry_outcomes_run_fk",
        columns: [table.runId, table.workspaceId],
        foreignColumns: [
          legalListVerificationRuns.id,
          legalListVerificationRuns.workspaceId,
        ],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "legal_list_claim_carry_outcomes_source_claim_fk",
        columns: [table.sourceClaimId, table.sourceRunId, table.workspaceId],
        foreignColumns: [
          legalListClaims.id,
          legalListClaims.runId,
          legalListClaims.workspaceId,
        ],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "legal_list_claim_carry_outcomes_target_claim_fk",
        columns: [table.targetClaimId, table.runId, table.workspaceId],
        foreignColumns: [
          legalListClaims.id,
          legalListClaims.runId,
          legalListClaims.workspaceId,
        ],
      })
      .onDelete("cascade"),
    p
      .index("legal_list_claim_carry_outcomes_run_idx")
      .on(table.workspaceId, table.runId),
    p
      .index("legal_list_claim_carry_outcomes_source_claim_idx")
      .on(table.workspaceId, table.sourceClaimId),
    // The feature gate finds a claim's outcomes by either claim.
    p
      .index("legal_list_claim_carry_outcomes_target_claim_idx")
      .on(table.workspaceId, table.targetClaimId),
    p.check(
      "legal_list_claim_carry_outcomes_outcome_check",
      sql`${table.outcome} IN (${CARRY_OUTCOME_SQL_VALUES})`,
    ),
    // A target claim exactly when one matched.
    p.check(
      "legal_list_claim_carry_outcomes_target_check",
      sql`(${table.targetClaimId} IS NOT NULL) = (${table.outcome} IN (${MATCHED_CARRY_OUTCOME_SQL_VALUES}))`,
    ),
    ...wsPolicies({
      columns: table,
      references: new Map([
        [
          table.runId,
          { kind: "owned-by-parent", parent: legalListVerificationRuns },
        ],
        [
          table.sourceClaimId,
          { kind: "owned-by-parent", parent: legalListClaims },
        ],
        [
          table.targetClaimId,
          { kind: "owned-by-parent", parent: legalListClaims },
        ],
      ]),
    }),
  ],
);
