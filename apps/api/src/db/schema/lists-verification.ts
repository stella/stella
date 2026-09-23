import {
  CLAIM_ANCHOR_TYPES,
  CLAIM_FRAMINGS,
  CLAIM_STATE,
  CLAIM_STATES,
  CLAIM_TYPES,
  VERIFICATION_LIMITS,
  CLAIM_REVIEW_EVENT_KINDS,
  VERIFICATION_RUN_ACTIVE_STATUSES,
  VERIFICATION_RUN_STATUSES,
  SCORED_CLAIM_STATES,
} from "@/api/lib/lists/verification/contract";
import type {
  ClaimAnchor,
  ClaimRef,
  ClaimSupersession,
  RecordConflict,
  ClaimReviewEventPayload,
  VerificationEvidence,
} from "@/api/lib/lists/verification/contract";

import {
  jsonb,
  p,
  pUuid,
  safeUuid,
  safeWorkspaceId,
  sql,
  stella,
  timestamptz,
  user,
  workspaceCheck,
  wsPolicies,
} from "./common";
import { workspaces } from "./contacts";

const quoted = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql`, `,
  );

const CLAIM_ANCHOR_TYPE_SQL_VALUES = quoted(CLAIM_ANCHOR_TYPES);
const RUN_STATUS_SQL_VALUES = quoted(VERIFICATION_RUN_STATUSES);
const RUN_ACTIVE_STATUS_SQL_VALUES = quoted(VERIFICATION_RUN_ACTIVE_STATUSES);
const CLAIM_TYPE_SQL_VALUES = quoted(CLAIM_TYPES);
const CLAIM_FRAMING_SQL_VALUES = quoted(CLAIM_FRAMINGS);
const CLAIM_STATE_SQL_VALUES = quoted(CLAIM_STATES);
const SCORED_CLAIM_STATE_SQL_VALUES = quoted(SCORED_CLAIM_STATES);
const REVIEW_EVENT_KIND_SQL_VALUES = quoted(CLAIM_REVIEW_EVENT_KINDS);
const NOTVERIFIABLE_SQL = sql.raw(`'${CLAIM_STATE.NOTVERIFIABLE}'`);
const RECORDCONFLICT_SQL = sql.raw(`'${CLAIM_STATE.RECORDCONFLICT}'`);

/**
 * One immutable verification of a document against a matter's anchor facts.
 *
 * The target and the evidence are pinned by value: `evidence` embeds every
 * fact the run read, and there is no foreign key to the document or the list.
 * A finished verification therefore stays readable after the list is edited
 * or the document moves on. Workspace deletion still cascades everything.
 */
export const legalListVerificationRuns = p.pgTable(
  "legal_list_verification_runs",
  {
    id: pUuid<"legalListVerificationRun">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Target pin. No foreign keys: a deleted document must not take its
    // verification history with it.
    entityId: safeUuid<"entity">("entity_id").notNull(),
    fileFieldId: safeUuid<"field">("file_field_id").notNull(),
    entityVersionId: safeUuid<"entityVersion">("entity_version_id").notNull(),
    contentSha256: p.varchar("content_sha256", { length: 64 }).notNull(),
    evidence: jsonb().$type<VerificationEvidence>().notNull(),
    status: p
      .text("status", { enum: VERIFICATION_RUN_STATUSES })
      .notNull()
      .default("queued"),
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
    // At most one unfinished run per document; makes a lost race impossible.
    p
      .uniqueIndex("legal_list_verification_runs_active_document_uidx")
      .on(table.workspaceId, table.entityId, table.fileFieldId)
      .where(sql`${table.status} IN (${RUN_ACTIVE_STATUS_SQL_VALUES})`),
    p.check(
      "legal_list_verification_runs_status_check",
      sql`${table.status} IN (${RUN_STATUS_SQL_VALUES})`,
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
    ...wsPolicies(),
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
    supersession: jsonb().$type<ClaimSupersession>(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
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
    ...wsPolicies(),
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
    id: pUuid<"legalListClaimReviewEvent">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    runId: safeUuid<"legalListVerificationRun">("run_id").notNull(),
    claimId: safeUuid<"legalListClaim">("claim_id").notNull(),
    kind: p.text("kind", { enum: CLAIM_REVIEW_EVENT_KINDS }).notNull(),
    payload: jsonb().$type<ClaimReviewEventPayload>().notNull(),
    actorId: p
      .text("actor_id")
      .references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
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
  ],
);
