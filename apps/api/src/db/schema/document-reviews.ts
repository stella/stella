import { sql } from "drizzle-orm";

import type { DocumentReviewTopic } from "@/api/lib/document-review/contract";
import {
  DOCUMENT_REVIEW_BASIS_TYPES,
  DOCUMENT_REVIEW_APPLICATION_STATUSES,
  DOCUMENT_REVIEW_APPLICATION_STATUS,
  DOCUMENT_REVIEW_CHECK_KIND,
  DOCUMENT_REVIEW_CHECK_KINDS,
  DOCUMENT_REVIEW_DECISION,
  DOCUMENT_REVIEW_DECISIONS,
  DOCUMENT_REVIEW_OUTCOMES,
  DOCUMENT_REVIEW_RUN_ACTIVE_STATUSES,
  DOCUMENT_REVIEW_RUN_ERROR_CODES,
  DOCUMENT_REVIEW_RUN_EXECUTOR,
  DOCUMENT_REVIEW_RUN_EXECUTORS,
  DOCUMENT_REVIEW_RUN_STATUSES,
} from "@/api/lib/document-review/run-contract";
import type {
  DocumentReviewFindingPayload,
  DocumentReviewRunBasis,
  DocumentReviewRunErrorCode,
} from "@/api/lib/document-review/run-contract";

import {
  jsonb,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  timestamptz,
  user,
  wsOrganizationPolicies,
} from "./common";
import { workspaces } from "./contacts";

const quoted = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql`, `,
  );

const RUN_STATUS_SQL_VALUES = quoted(DOCUMENT_REVIEW_RUN_STATUSES);
const RUN_ACTIVE_STATUS_SQL_VALUES = quoted(
  DOCUMENT_REVIEW_RUN_ACTIVE_STATUSES,
);
const RUN_ERROR_CODE_SQL_VALUES = quoted(DOCUMENT_REVIEW_RUN_ERROR_CODES);
const RUN_EXECUTOR_SQL_VALUES = quoted(DOCUMENT_REVIEW_RUN_EXECUTORS);
const BASIS_TYPE_SQL_VALUES = quoted(DOCUMENT_REVIEW_BASIS_TYPES);
const CHECK_KIND_SQL_VALUES = quoted(DOCUMENT_REVIEW_CHECK_KINDS);
const PLAYBOOK_OUTCOME_SQL_VALUES = quoted(DOCUMENT_REVIEW_OUTCOMES.playbook);
const REFERENCE_OUTCOME_SQL_VALUES = quoted(DOCUMENT_REVIEW_OUTCOMES.reference);

const DECISION_SQL_VALUES = quoted(DOCUMENT_REVIEW_DECISIONS);
const APPLICATION_STATUS_SQL_VALUES = quoted(
  DOCUMENT_REVIEW_APPLICATION_STATUSES,
);

const PLAYBOOK_CHECK_KIND_SQL = sql.raw(
  `'${DOCUMENT_REVIEW_CHECK_KIND.PLAYBOOK}'`,
);
const REFERENCE_CHECK_KIND_SQL = sql.raw(
  `'${DOCUMENT_REVIEW_CHECK_KIND.REFERENCE}'`,
);
const OPEN_DECISION_SQL = sql.raw(`'${DOCUMENT_REVIEW_DECISION.OPEN}'`);
const PENDING_APPLICATION_STATUS_SQL = sql.raw(
  `'${DOCUMENT_REVIEW_APPLICATION_STATUS.PENDING}'`,
);

/**
 * One immutable execution of a document review: a confirmed basis (a playbook,
 * a set of reference documents, or both) measured against one pinned document
 * version.
 *
 * The target and the basis are pinned by value, not by reference: `basis`
 * embeds the whole playbook snapshot and every reference's version, and there
 * is no foreign key from a run to a playbook or to the reviewed documents. A
 * completed review therefore stays readable after the playbook is deleted or
 * the document moves on. Workspace deletion still cascades everything.
 */
export const documentReviewRuns = p.pgTable(
  "document_review_runs",
  {
    id: pUuid<"documentReviewRun">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Target pin. Plain identifier columns: a deleted document must not take
    // its review history with it, so these deliberately carry no foreign key.
    entityId: safeUuid<"entity">("entity_id").notNull(),
    fileFieldId: safeUuid<"field">("file_field_id").notNull(),
    entityVersionId: safeUuid<"entityVersion">("entity_version_id").notNull(),
    contentSha256: p.varchar("content_sha256", { length: 64 }).notNull(),
    // Query projection for per-user recent playbooks. Deliberately no foreign
    // key: a deleted playbook must not erase or invalidate review history.
    playbookDefinitionId: safeUuid<"playbookDefinition">(
      "playbook_definition_id",
    ),
    basis: jsonb().$type<DocumentReviewRunBasis>().notNull(),
    // The confirmed topic list exactly as the reviewer approved it. Capped by
    // the request schema (`DOCUMENT_REVIEW_LIMITS.topicsMax`).
    topics: jsonb().$type<DocumentReviewTopic[]>().notNull(),
    status: p
      .text("status", { enum: DOCUMENT_REVIEW_RUN_STATUSES })
      .notNull()
      .default("queued"),
    errorCode: p
      .varchar("error_code", { length: 64 })
      .$type<DocumentReviewRunErrorCode>(),
    // Who carries this run to a terminal state. A document holds at most one
    // active run, so the two producers must be told apart by name: neither may
    // commit findings into a run the other owns.
    executor: p
      .text("executor", { enum: DOCUMENT_REVIEW_RUN_EXECUTORS })
      .notNull()
      .default(DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER),
    // Coarse progress over the expected finding set (see `expectedFindings`).
    total: p.integer().notNull().default(0),
    completed: p.integer().notNull().default(0),
    requestedBy: p
      .text("requested_by")
      .references(() => user.id, { onDelete: "set null" }),
    // Bumped when the executed pipeline changes shape, so an old run is never
    // silently read as if it had been produced by today's engine.
    pipelineVersion: p.integer("pipeline_version").notNull().default(1),
    // The model identity the run resolved to, recorded for reproducibility.
    modelRef: p.varchar("model_ref", { length: 256 }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
  },
  (table) => [
    // History read: newest runs for one document, keyset-paginated.
    p
      .index("document_review_runs_document_created_idx")
      .on(
        table.workspaceId,
        table.entityId,
        table.fileFieldId,
        table.createdAt.desc(),
        table.id.desc(),
      ),
    p
      .index("document_review_runs_org_user_playbook_created_idx")
      .on(
        table.organizationId,
        table.requestedBy,
        table.playbookDefinitionId,
        table.createdAt.desc(),
        table.id.desc(),
      )
      .where(sql`${table.playbookDefinitionId} IS NOT NULL`),
    // At most one unfinished run per document. The endpoint answers 409 before
    // reaching here; this index is what makes a lost race impossible rather
    // than unlikely.
    p
      .uniqueIndex("document_review_runs_active_document_uidx")
      .on(table.workspaceId, table.entityId, table.fileFieldId)
      .where(sql`${table.status} IN (${RUN_ACTIVE_STATUS_SQL_VALUES})`),
    p.check(
      "document_review_runs_status_values_check",
      sql`${table.status} IN (${RUN_STATUS_SQL_VALUES})`,
    ),
    p.check(
      "document_review_runs_error_code_values_check",
      sql`${table.errorCode} IS NULL OR ${table.errorCode} IN (${RUN_ERROR_CODE_SQL_VALUES})`,
    ),
    p.check(
      "document_review_runs_executor_values_check",
      sql`${table.executor} IN (${RUN_EXECUTOR_SQL_VALUES})`,
    ),
    p.check(
      "document_review_runs_basis_type_check",
      sql`${table.basis}->>'type' IN (${BASIS_TYPE_SQL_VALUES})`,
    ),
    p.check(
      "document_review_runs_progress_nonnegative_check",
      sql`${table.total} >= 0 AND ${table.completed} >= 0`,
    ),
    p.check(
      "document_review_runs_completed_within_total_check",
      sql`${table.completed} <= ${table.total}`,
    ),
    p.check(
      "document_review_runs_content_hash_check",
      sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    p.check(
      "document_review_runs_pipeline_version_check",
      sql`${table.pipelineVersion} > 0`,
    ),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "document_review_runs_workspace_organization_fk",
      })
      .onDelete("cascade"),
    // Both scopes in every command: the run row carries an organization
    // discriminator, so a valid workspace pin must not authorize a row whose
    // organization_id came from anywhere else.
    ...wsOrganizationPolicies("document_review_runs"),
  ],
);

/**
 * One judgment per confirmed topic per check kind. `(runId, topicId,
 * checkKind)` is the upsert key, so a re-delivered job converges onto the rows
 * it already wrote instead of duplicating them.
 *
 * Reads are keyed by document rather than by run: the current review state of a
 * document is the findings of its latest completed run.
 */
export const documentReviewFindings = p.pgTable(
  "document_review_findings",
  {
    id: pUuid<"documentReviewFinding">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: safeUuid<"documentReviewRun">("run_id")
      .notNull()
      .references(() => documentReviewRuns.id, { onDelete: "cascade" }),
    // Denormalized read keys so the document-keyed read never joins the run.
    entityId: safeUuid<"entity">("entity_id").notNull(),
    fileFieldId: safeUuid<"field">("file_field_id").notNull(),
    entityVersionId: safeUuid<"entityVersion">("entity_version_id").notNull(),
    topicId: p.uuid("topic_id").notNull(),
    // Denormalized so a report renders without the run's topic snapshot.
    topicTitle: p.varchar("topic_title", { length: 256 }).notNull(),
    checkKind: p
      .text("check_kind", { enum: DOCUMENT_REVIEW_CHECK_KINDS })
      .notNull(),
    // Set only on a playbook-kind row, which grades one playbook position.
    positionId: p.uuid("position_id"),
    // Verdict tiers for the playbook kind, the comparison vocabulary for the
    // reference kind. The two are never merged. Null only for an extract-only
    // position, which produces a value with no verdict.
    outcome: p.varchar("outcome", { length: 64 }),
    payload: jsonb().$type<DocumentReviewFindingPayload>().notNull(),
    // Reviewer disposition. Findings are born `open`; a decision names who
    // took it and when, and survives a re-run whose finding says the same
    // thing about the same evidence (see `decision-carry-over.ts`).
    decision: p
      .text("decision", { enum: DOCUMENT_REVIEW_DECISIONS })
      .notNull()
      .default(DOCUMENT_REVIEW_DECISION.OPEN),
    // Nulled when the decider's account is removed; the decision itself and
    // its timestamp stay, so an audited disposition never disappears with a
    // person.
    decidedBy: p
      .text("decided_by")
      .references(() => user.id, { onDelete: "set null" }),
    decidedAt: timestamptz("decided_at"),
    // Applying a proposed fix is a separate durable action from accepting the
    // finding. The status survives a reload so the same tracked change cannot
    // be offered and inserted twice.
    applicationStatus: p
      .text("application_status", {
        enum: DOCUMENT_REVIEW_APPLICATION_STATUSES,
      })
      .notNull()
      .default(DOCUMENT_REVIEW_APPLICATION_STATUS.PENDING),
    appliedBy: p
      .text("applied_by")
      .references(() => user.id, { onDelete: "set null" }),
    appliedAt: timestamptz("applied_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("document_review_findings_run_topic_kind_uidx")
      .on(table.runId, table.topicId, table.checkKind),
    p
      .index("document_review_findings_document_idx")
      .on(table.workspaceId, table.entityId, table.fileFieldId),
    p.check(
      "document_review_findings_check_kind_values_check",
      sql`${table.checkKind} IN (${CHECK_KIND_SQL_VALUES})`,
    ),
    // Per-kind outcome vocabulary, plus the invariant that only a playbook-kind
    // row names a position.
    p.check(
      "document_review_findings_outcome_check",
      sql`(
        ${table.checkKind} = ${PLAYBOOK_CHECK_KIND_SQL}
        AND (
          ${table.outcome} IS NULL
          OR ${table.outcome} IN (${PLAYBOOK_OUTCOME_SQL_VALUES})
        )
      ) OR (
        ${table.checkKind} = ${REFERENCE_CHECK_KIND_SQL}
        AND ${table.outcome} IN (${REFERENCE_OUTCOME_SQL_VALUES})
        AND ${table.positionId} IS NULL
      )`,
    ),
    p.check(
      "document_review_findings_decision_values_check",
      sql`${table.decision} IN (${DECISION_SQL_VALUES})`,
    ),
    // "Open" and "undecided" are the same fact stated twice, so the schema
    // keeps them identical: a decided finding always names its moment, and an
    // open one never does. `decided_by` is deliberately outside this rule —
    // deleting the decider's account nulls it without reopening the finding.
    p.check(
      "document_review_findings_decision_timing_check",
      sql`(${table.decision} = ${OPEN_DECISION_SQL}) = (${table.decidedAt} IS NULL)`,
    ),
    p.check(
      "document_review_findings_application_status_values_check",
      sql`${table.applicationStatus} IN (${APPLICATION_STATUS_SQL_VALUES})`,
    ),
    p.check(
      "document_review_findings_application_timing_check",
      sql`(${table.applicationStatus} = ${PENDING_APPLICATION_STATUS_SQL}) = (${table.appliedAt} IS NULL)`,
    ),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "document_review_findings_workspace_organization_fk",
      })
      .onDelete("cascade"),
    ...wsOrganizationPolicies("document_review_findings"),
  ],
);
