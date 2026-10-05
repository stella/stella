/**
 * Per-decision provision-citation state: which input each decision's stored
 * provision rows were produced from, what is owed, and which scopes and
 * extraction revisions admit work.
 *
 * No application role may insert into `case_law_provision_extractions` or
 * read the scope table. State rows are created only by the
 * `case_law_decisions` enqueue trigger and
 * `ensure_case_law_provision_extraction_state`, both of which hold the
 * decision's row lock, and scope admission is read only through
 * `case_law_provision_extraction_in_scope` (migration
 * `20260926160000_case_law_provision_extraction_state`). All three run as
 * the owner.
 */

import type { SQLWrapper } from "drizzle-orm";

import { caseLawDecisions } from "./case-law";
import {
  bytea,
  globalCaseLawPolicies,
  jsonb,
  p,
  publicLawReaderPolicies,
  safeUuid,
  sql,
  timestamptz,
} from "./common";

const sqlValues = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql.raw(","),
  );

const claimableProvisionExtraction = ({
  dueAt,
  workStatus,
}: {
  dueAt: SQLWrapper;
  workStatus: SQLWrapper;
}) => sql`${dueAt} IS NOT NULL AND ${workStatus} <> 'blocked'`;

/**
 * Row security is forced on every table here (migration
 * `20260926160000_case_law_provision_extraction_state`), so the owner-run
 * functions need a policy too. The owner role is named per deployment, so the
 * policy admits every role and table privileges decide access.
 */
const ownerAccessPolicy = () =>
  p.pgPolicy("case_law_provision_extraction_owner_access", {
    for: "all",
    to: "public",
    using: sql`true`,
    withCheck: sql`true`,
  });

const PROVISION_EXTRACTION_SCOPE_STATUSES = ["active", "retired"] as const;

const PROVISION_SCOPE_TRANSITION_ACTIONS = ["activate", "retire"] as const;

const PROVISION_REPAIR_CURSOR_NAMES = [
  "scope-bootstrap",
  "state-seed",
] as const;

/** Fresh ingestion outranks repairs, which outrank bulk backfills. */
const PROVISION_EXTRACTION_LANES = ["fresh", "repair", "backfill"] as const;

const PROVISION_EXTRACTION_ENQUEUE_REASONS = [
  "input",
  "seed",
  "reconcile",
  "scope_activated",
  "scope_retired",
  "revision_sweep",
] as const;

const PROVISION_EXTRACTION_WORK_STATUSES = [
  "eligible",
  "retry_scheduled",
  "blocked",
] as const;

const PROVISION_EXTRACTION_OUTCOMES = [
  "extracted_with_rows",
  "extracted_zero",
  "terminal",
] as const;

const PROVISION_EXTRACTION_TERMINAL_REASONS = [
  "empty_document",
  "withheld",
  "unplaceable",
  "out_of_scope",
] as const;

const PROVISION_EXTRACTION_PAYLOAD_CLASSES = [
  "usable",
  "empty_envelope",
  "unusable",
] as const;

/**
 * One row per `(country, language)` a decision has carried. Rows are never
 * deleted: a key nobody configured is `retired`, so every decision's key
 * has a row to lock and to read admission from. `generation` advances on
 * every transition, which is what makes a claim or a transition page taken
 * under an older generation fail admission.
 */
export const caseLawProvisionExtractionScopes = p.pgTable.withRLS(
  "case_law_provision_extraction_scopes",
  {
    country: p.varchar({ length: 3 }).notNull(),
    language: p.varchar({ length: 8 }).notNull(),
    status: p.text({ enum: PROVISION_EXTRACTION_SCOPE_STATUSES }).notNull(),
    generation: p.bigint({ mode: "number" }).notNull(),
  },
  (t) => [
    p.primaryKey({
      name: "case_law_provision_extraction_scopes_pkey",
      columns: [t.country, t.language],
    }),
    p.check(
      "case_law_provision_extraction_scopes_status_values",
      sql`${t.status} IN (${sqlValues(PROVISION_EXTRACTION_SCOPE_STATUSES)})`,
    ),
    p.check(
      "case_law_provision_extraction_scopes_generation_positive",
      sql`${t.generation} > 0`,
    ),
    ownerAccessPolicy(),
  ],
);

/**
 * The durable job behind one scope transition: which generation it applies,
 * and how far through the scope's decisions (by id) it has got.
 */
export const caseLawProvisionScopeTransitions = p.pgTable(
  "case_law_provision_scope_transitions",
  {
    country: p.varchar({ length: 3 }).notNull(),
    language: p.varchar({ length: 8 }).notNull(),
    generation: p.bigint({ mode: "number" }).notNull(),
    action: p.text({ enum: PROVISION_SCOPE_TRANSITION_ACTIONS }).notNull(),
    cursorDecisionId: safeUuid<"caseLawDecision">("cursor_decision_id"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    completedAt: timestamptz("completed_at"),
  },
  (t) => [
    p.primaryKey({
      name: "case_law_provision_scope_transitions_pkey",
      columns: [t.country, t.language, t.generation],
    }),
    p
      .foreignKey({
        name: "case_law_provision_scope_transitions_scope_fk",
        columns: [t.country, t.language],
        foreignColumns: [
          caseLawProvisionExtractionScopes.country,
          caseLawProvisionExtractionScopes.language,
        ],
      })
      .onDelete("restrict"),
    p.check(
      "case_law_provision_scope_transitions_action_values",
      sql`${t.action} IN (${sqlValues(PROVISION_SCOPE_TRANSITION_ACTIONS)})`,
    ),
    ...globalCaseLawPolicies(),
    ownerAccessPolicy(),
  ],
);

/** Cursor for each one-time decision-id walk; the enqueue trigger covers later writes. */
export const caseLawProvisionRepairCursors = p.pgTable.withRLS(
  "case_law_provision_repair_cursors",
  {
    name: p.text({ enum: PROVISION_REPAIR_CURSOR_NAMES }).primaryKey(),
    cursorDecisionId: safeUuid<"caseLawDecision">("cursor_decision_id"),
    completedAt: timestamptz("completed_at"),
  },
  (t) => [
    p.check(
      "case_law_provision_repair_cursors_name_values",
      sql`${t.name} IN (${sqlValues(PROVISION_REPAIR_CURSOR_NAMES)})`,
    ),
    ownerAccessPolicy(),
  ],
);

/**
 * The highest provision extraction admission revision a deployment has
 * applied to the scopes. A trigger refuses a decrease and a delete.
 */
export const caseLawProvisionAdmission = p.pgTable.withRLS(
  "case_law_provision_admission",
  {
    key: p.text().primaryKey(),
    revision: p.integer().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (t) => [
    p.check("case_law_provision_admission_key", sql`${t.key} = 'global'`),
    p.check(
      "case_law_provision_admission_revision_positive",
      sql`${t.revision} > 0`,
    ),
    ownerAccessPolicy(),
  ],
);

/**
 * What one extraction revision means for one jurisdiction. Immutable: a
 * trigger refuses UPDATE and DELETE, so a revision number can never be
 * reused for different semantics.
 */
export const caseLawProvisionExtractionRevisionsRegistry = p.pgTable(
  "case_law_provision_extraction_revisions_registry",
  {
    revision: p.integer().notNull(),
    jurisdiction: p.varchar({ length: 3 }).notNull(),
    engineInputDigest: p
      .varchar("engine_input_digest", { length: 64 })
      .notNull(),
    profileDigest: p.varchar("profile_digest", { length: 64 }).notNull(),
    projectionRevision: p.smallint("projection_revision").notNull(),
    registeredAt: timestamptz("registered_at").defaultNow().notNull(),
  },
  (t) => [
    p.primaryKey({
      name: "case_law_provision_extraction_revisions_registry_pkey",
      columns: [t.revision, t.jurisdiction],
    }),
    p.check(
      "case_law_provision_extraction_registry_positive",
      sql`${t.revision} > 0 AND ${t.projectionRevision} > 0`,
    ),
    p.check(
      "case_law_provision_extraction_revisions_registry_digest_shape",
      sql`${t.engineInputDigest} ~ '^[0-9a-f]{64}$' AND ${t.profileDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    ...globalCaseLawPolicies(),
    ownerAccessPolicy(),
    ...publicLawReaderPolicies(),
  ],
);

/**
 * The revision each jurisdiction extracts at, and the oldest revision whose
 * output still counts as current. A trigger refuses any decrease of either
 * and any delete; rolling back is a new, higher revision.
 */
export const caseLawProvisionExtractionRevisions = p.pgTable(
  "case_law_provision_extraction_revisions",
  {
    jurisdiction: p.varchar({ length: 3 }).primaryKey(),
    desiredRevision: p.integer("desired_revision").notNull(),
    minCurrentRevision: p.integer("min_current_revision").notNull(),
    changedAt: timestamptz("changed_at").defaultNow().notNull(),
  },
  (t) => [
    p
      .foreignKey({
        name: "case_law_provision_extraction_revisions_registry_fk",
        columns: [t.desiredRevision, t.jurisdiction],
        foreignColumns: [
          caseLawProvisionExtractionRevisionsRegistry.revision,
          caseLawProvisionExtractionRevisionsRegistry.jurisdiction,
        ],
      })
      .onDelete("restrict"),
    p.check(
      "case_law_provision_extraction_revisions_floor",
      sql`${t.minCurrentRevision} > 0 AND ${t.minCurrentRevision} <= ${t.desiredRevision}`,
    ),
    ...globalCaseLawPolicies(),
    ownerAccessPolicy(),
    ...publicLawReaderPolicies(),
  ],
);

const EXTRACTED_OUTCOMES_SQL = sql.raw(
  `'extracted_with_rows','extracted_zero'`,
);

/**
 * One row per decision the provision extraction owes or has published.
 *
 * The desired side (`desired_input_digest` through `lease_expires_at`) says
 * what is owed; the published side (`generation` onwards) is written only
 * together with the decision's provision rows, so the two always describe
 * the same output.
 */
export const caseLawProvisionExtractions = p.pgTable(
  "case_law_provision_extractions",
  {
    decisionId: safeUuid<"caseLawDecision">("decision_id").primaryKey(),
    jurisdiction: p.varchar({ length: 3 }).notNull(),
    desiredInputDigest: bytea("desired_input_digest").notNull(),
    lane: p.text({ enum: PROVISION_EXTRACTION_LANES }).notNull(),
    dueAt: timestamptz("due_at"),
    enqueueReason: p.text("enqueue_reason", {
      enum: PROVISION_EXTRACTION_ENQUEUE_REASONS,
    }),
    workStatus: p
      .text("work_status", { enum: PROVISION_EXTRACTION_WORK_STATUSES })
      .notNull()
      .default("eligible"),
    retryNotBefore: timestamptz("retry_not_before"),
    failureAttempts: p.integer("failure_attempts").notNull().default(0),
    transientAttempts: p.integer("transient_attempts").notNull().default(0),
    lastFailureKind: p.varchar("last_failure_kind", { length: 64 }),
    lastFailureMessage: p.varchar("last_failure_message", { length: 2048 }),
    blockedInputDigest: bytea("blocked_input_digest"),
    leaseToken: p.uuid("lease_token"),
    leaseExpiresAt: timestamptz("lease_expires_at"),
    generation: p.bigint({ mode: "number" }).notNull().default(0),
    outcome: p.text({ enum: PROVISION_EXTRACTION_OUTCOMES }),
    terminalReason: p.text("terminal_reason", {
      enum: PROVISION_EXTRACTION_TERMINAL_REASONS,
    }),
    publishedInputDigest: bytea("published_input_digest"),
    publishedJurisdiction: p.varchar("published_jurisdiction", { length: 3 }),
    publishedRevision: p.integer("published_revision"),
    publishedProjectionDigest: bytea("published_projection_digest"),
    payloadClass: p.text("payload_class", {
      enum: PROVISION_EXTRACTION_PAYLOAD_CLASSES,
    }),
    payloadClassInputDigest: bytea("payload_class_input_digest"),
    rowCount: p.integer("row_count"),
    rowsDigest: p.varchar("rows_digest", { length: 64 }),
    unresolvedCounts:
      jsonb("unresolved_counts").$type<Record<string, number>>(),
    publishedAt: timestamptz("published_at"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (t) => [
    p
      .foreignKey({
        name: "case_law_provision_extractions_decision_fk",
        columns: [t.decisionId],
        foreignColumns: [caseLawDecisions.id],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "case_law_provision_extractions_revision_fk",
        columns: [t.publishedRevision, t.publishedJurisdiction],
        foreignColumns: [
          caseLawProvisionExtractionRevisionsRegistry.revision,
          caseLawProvisionExtractionRevisionsRegistry.jurisdiction,
        ],
      })
      .onDelete("restrict"),
    p
      .index("case_law_provision_extractions_due_idx")
      .on(t.lane, t.dueAt, t.decisionId)
      .where(claimableProvisionExtraction(t)),
    p
      .index("case_law_provision_extractions_jurisdiction_due_idx")
      .on(t.jurisdiction, t.lane, t.dueAt, t.decisionId)
      .where(claimableProvisionExtraction(t)),
    p
      .index("case_law_provision_extractions_retry_idx")
      .on(t.retryNotBefore, t.decisionId)
      .where(sql`${t.workStatus} = 'retry_scheduled'`),
    p
      .index("case_law_provision_extractions_blocked_idx")
      .on(t.decisionId)
      .where(sql`${t.workStatus} = 'blocked'`),
    p
      .index("case_law_provision_extractions_lease_idx")
      .on(t.leaseExpiresAt)
      .where(sql`${t.leaseToken} IS NOT NULL`),
    p.check(
      "case_law_provision_extractions_lane_values",
      sql`${t.lane} IN (${sqlValues(PROVISION_EXTRACTION_LANES)})`,
    ),
    p.check(
      "case_law_provision_extractions_enqueue_reason_values",
      sql`${t.enqueueReason} IS NULL OR ${t.enqueueReason} IN (${sqlValues(PROVISION_EXTRACTION_ENQUEUE_REASONS)})`,
    ),
    p.check(
      "case_law_provision_extractions_work_status_values",
      sql`${t.workStatus} IN (${sqlValues(PROVISION_EXTRACTION_WORK_STATUSES)})`,
    ),
    p.check(
      "case_law_provision_extractions_outcome_values",
      sql`${t.outcome} IS NULL OR ${t.outcome} IN (${sqlValues(PROVISION_EXTRACTION_OUTCOMES)})`,
    ),
    p.check(
      "case_law_provision_extractions_terminal_reason_values",
      sql`${t.terminalReason} IS NULL OR ${t.terminalReason} IN (${sqlValues(PROVISION_EXTRACTION_TERMINAL_REASONS)})`,
    ),
    p.check(
      "case_law_provision_extractions_payload_class_values",
      sql`${t.payloadClass} IS NULL OR ${t.payloadClass} IN (${sqlValues(PROVISION_EXTRACTION_PAYLOAD_CLASSES)})`,
    ),
    p.check(
      "case_law_provision_extractions_digest_lengths",
      sql`octet_length(${t.desiredInputDigest}) = 32 AND coalesce(octet_length(${t.blockedInputDigest}), 32) = 32 AND coalesce(octet_length(${t.publishedInputDigest}), 32) = 32 AND coalesce(octet_length(${t.publishedProjectionDigest}), 32) = 32 AND coalesce(octet_length(${t.payloadClassInputDigest}), 32) = 32`,
    ),
    p.check(
      "case_law_provision_extractions_counters",
      sql`${t.generation} >= 0 AND ${t.failureAttempts} >= 0 AND ${t.transientAttempts} >= 0 AND coalesce(${t.rowCount}, 0) >= 0`,
    ),
    // Published iff the new writer has published: generation, outcome,
    // publication time and published digest move together.
    p.check(
      "case_law_provision_extractions_published_shape",
      sql`(${t.generation} = 0) = (${t.outcome} IS NULL) AND (${t.outcome} IS NULL) = (${t.publishedAt} IS NULL) AND (${t.outcome} IS NULL) = (${t.publishedInputDigest} IS NULL)`,
    ),
    p.check(
      "case_law_provision_extractions_lease_shape",
      sql`(${t.leaseToken} IS NULL) = (${t.leaseExpiresAt} IS NULL)`,
    ),
    p.check(
      "case_law_provision_extractions_retry_shape",
      sql`${t.workStatus} <> 'retry_scheduled' OR ${t.retryNotBefore} IS NOT NULL`,
    ),
    p.check(
      "case_law_provision_extractions_blocked_shape",
      sql`${t.workStatus} <> 'blocked' OR ${t.blockedInputDigest} IS NOT NULL`,
    ),
    p.check(
      "case_law_provision_extractions_terminal_shape",
      sql`(${t.terminalReason} IS NOT NULL) = coalesce(${t.outcome} = 'terminal', false)`,
    ),
    // An extraction publishes its rows' count, identity digest and the
    // projection they were placed on; zero rows is its own outcome.
    p.check(
      "case_law_provision_extractions_extracted_shape",
      sql`coalesce(${t.outcome} NOT IN (${EXTRACTED_OUTCOMES_SQL}), true) OR (${t.rowCount} IS NOT NULL AND ${t.rowsDigest} IS NOT NULL AND ${t.publishedProjectionDigest} IS NOT NULL AND (${t.rowCount} = 0) = (${t.outcome} = 'extracted_zero'))`,
    ),
    // Only an extraction binds a revision; a terminal outcome and an
    // unpublished row bind none.
    p.check(
      "case_law_provision_extractions_binding_shape",
      sql`(${t.publishedRevision} IS NULL) = (${t.publishedJurisdiction} IS NULL) AND (${t.publishedRevision} IS NOT NULL) = coalesce(${t.outcome} IN (${EXTRACTED_OUTCOMES_SQL}), false)`,
    ),
    p.check(
      "case_law_provision_extractions_payload_class_shape",
      sql`(${t.payloadClass} IS NULL) = (${t.payloadClassInputDigest} IS NULL)`,
    ),
    p.check(
      "case_law_provision_extractions_rows_digest_shape",
      sql`${t.rowsDigest} IS NULL OR ${t.rowsDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    ...globalCaseLawPolicies(),
    ownerAccessPolicy(),
    ...publicLawReaderPolicies(),
  ],
);
