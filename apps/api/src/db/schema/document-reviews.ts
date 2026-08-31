import { sql } from "drizzle-orm";

import { REVIEW_SKIPPED_MAX } from "@/api/lib/document-review/contract";
import type {
  ReviewParty,
  ReviewSkippedTerm,
} from "@/api/lib/document-review/contract";
import {
  DOCUMENT_REVIEW_APPLICATION_STATUSES,
  DOCUMENT_REVIEW_APPLICATION_STATUS,
  DOCUMENT_REVIEW_DECISION,
  DOCUMENT_REVIEW_DECISIONS,
  DOCUMENT_REVIEW_FINDING_FLAGS,
  DOCUMENT_REVIEW_FINDING_FLAGS_MAX,
  DOCUMENT_REVIEW_OUTCOMES,
  DOCUMENT_REVIEW_RUN_ACTIVE_STATUSES,
  DOCUMENT_REVIEW_RUN_ERROR_CODES,
  DOCUMENT_REVIEW_RUN_EXECUTOR,
  DOCUMENT_REVIEW_RUN_EXECUTORS,
  DOCUMENT_REVIEW_RUN_STATUSES,
  PLAYBOOK_PIN_PROVENANCES,
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
import { entities, entityVersions } from "./entities";

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
const PIN_PROVENANCE_SQL_VALUES = quoted(PLAYBOOK_PIN_PROVENANCES);
const OUTCOME_SQL_VALUES = quoted(DOCUMENT_REVIEW_OUTCOMES);

const DECISION_SQL_VALUES = quoted(DOCUMENT_REVIEW_DECISIONS);
const FINDING_FLAG_SQL_VALUES = quoted(DOCUMENT_REVIEW_FINDING_FLAGS);
const APPLICATION_STATUS_SQL_VALUES = quoted(
  DOCUMENT_REVIEW_APPLICATION_STATUSES,
);

const OPEN_DECISION_SQL = sql.raw(`'${DOCUMENT_REVIEW_DECISION.OPEN}'`);
const PENDING_APPLICATION_STATUS_SQL = sql.raw(
  `'${DOCUMENT_REVIEW_APPLICATION_STATUS.PENDING}'`,
);

/**
 * One immutable execution of a document review: a confirmed position list,
 * with the reference documents those positions came from and the side it was
 * judged for, measured against one pinned document version.
 *
 * The target and the basis are pinned by value, not by reference: `basis`
 * embeds the whole position snapshot and every reference's version, and there
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
    // What the proposal pass read and deliberately did not turn into a
    // position. Pinned on the run beside the positions rather than left in the
    // browser: a checklist that silently omits half the document reads as if
    // the other half were compliant, and that stays true when the review is
    // reopened tomorrow. Empty for a run with no proposal behind it.
    skipped: jsonb().$type<ReviewSkippedTerm[]>().notNull().default([]),
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
    pipelineVersion: p.integer("pipeline_version").notNull().default(2),
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
    // The basis always pins a playbook snapshot and says where it came from;
    // an ephemeral pin is the only one without a definition to point at.
    p.check(
      "document_review_runs_basis_shape_check",
      sql`${table.basis}->'playbook'->>'provenance' IN (${PIN_PROVENANCE_SQL_VALUES})
        AND jsonb_typeof(${table.basis}->'playbook'->'definitionSnapshot'->'positions') = 'object'`,
    ),
    // A list, and no longer than the proposal pass will report. The column
    // states it: the array arrives element by element from the wire, and
    // Drizzle's `$type` is compile-time only.
    p.check(
      "document_review_runs_skipped_shape_check",
      sql`jsonb_typeof(${table.skipped}) = 'array'
        AND jsonb_array_length(${table.skipped}) <= ${sql.raw(String(REVIEW_SKIPPED_MAX))}`,
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
 * One judgment per confirmed position. `(runId, positionId)` is the upsert
 * key, so a re-delivered job converges onto the rows it already wrote instead
 * of duplicating them.
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
    // The position this judges, by its playbook-stable `sourceId`. Deliberately
    // no foreign key: the position lives in the run's pinned snapshot, and the
    // decision overlay reads findings by this id across an organization's runs
    // long after any definition that held it is gone.
    positionId: p.uuid("position_id").notNull(),
    // Denormalized so a report renders without the run's position snapshot.
    positionTitle: p.varchar("position_title", { length: 256 }).notNull(),
    // One verdict vocabulary, whatever the standard was. Null only for an
    // extract-only position, which produces a value with no verdict.
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
    // Reviewer flags, the same vocabulary the files table's cell flags use.
    // A set, not a list: the CHECK below bounds it by the vocabulary's size,
    // and the handler writes it deduplicated and sorted so two orderings of
    // the same flags are one value.
    flags: p
      .text("flags", { enum: DOCUMENT_REVIEW_FINDING_FLAGS })
      .array()
      .notNull()
      .default([]),
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
      .uniqueIndex("document_review_findings_run_position_uidx")
      .on(table.runId, table.positionId),
    p
      .index("document_review_findings_document_idx")
      .on(table.workspaceId, table.entityId, table.fileFieldId),
    // The decision overlay: how an organization has decided one position
    // across every run that graded it.
    p
      .index("document_review_findings_org_position_idx")
      .on(table.organizationId, table.positionId),
    p.check(
      "document_review_findings_outcome_check",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN (${OUTCOME_SQL_VALUES})`,
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
    // Every element is a flag the vocabulary names, and no finding holds more
    // flags than the vocabulary has. Drizzle's `enum` option is compile-time
    // only, and the array arrives element by element from the wire, so the
    // column states the rule itself.
    p.check(
      "document_review_findings_flags_values_check",
      sql`${table.flags} <@ ARRAY[${FINDING_FLAG_SQL_VALUES}]::text[]
        AND cardinality(${table.flags}) <= ${sql.raw(String(DOCUMENT_REVIEW_FINDING_FLAGS_MAX))}`,
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

/**
 * The target document's parties, detected once per document version so the
 * review launcher can show "We act for" before any proposal pass runs.
 *
 * One row per version: the answer is deterministic for a version's content,
 * so a re-detection overwrites the row (see `promptVersion` below) rather
 * than accumulating history the way a run does.
 */
export const documentReviewParties = p.pgTable(
  "document_review_parties",
  {
    id: pUuid<"documentReviewParty">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    entityVersionId: safeUuid<"entityVersion">("entity_version_id")
      .notNull()
      .references(() => entityVersions.id, { onDelete: "cascade" }),
    // Bumped when the detection prompt changes shape, so a stale row is
    // recomputed instead of read as today's answer.
    promptVersion: p.smallint("prompt_version").notNull(),
    parties: jsonb().$type<ReviewParty[]>().notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .uniqueIndex("document_review_parties_entity_version_uidx")
      .on(table.entityVersionId),
    p
      .foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
        name: "document_review_parties_entity_workspace_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "document_review_parties_workspace_organization_fk",
      })
      .onDelete("cascade"),
    ...wsOrganizationPolicies("document_review_parties"),
  ],
);

/**
 * The words a reference-derived position quotes: one row per block of a
 * reference document version, owned by the matter that document belongs to.
 *
 * This is the only place reference text is persisted. Positions, run bases,
 * findings and playbooks hold the row's id and provenance, so a run in one
 * matter and a playbook shared across the organization never store another
 * matter's clauses; the matter's own row security decides, per reader, whether
 * the words come back. Rows are content-addressed by (version, block): a
 * block quoted by ten positions is one row.
 */
export const documentReviewReferencePassages = p.pgTable(
  "document_review_reference_passages",
  {
    id: pUuid<"documentReviewReferencePassage">().primaryKey(),
    // Both scope FKs are named by hand: the generated names run past
    // Postgres's 63-byte identifier limit and would be silently truncated.
    organizationId: safeOrganizationId("organization_id").notNull(),
    // The matter the reference document lives in, not the matter of any run
    // that quotes it: that is what row security scopes by.
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    fileFieldId: safeUuid<"field">("file_field_id").notNull(),
    // Provenance, not a foreign key: a passage outlives the pruning of the
    // version it was read from as long as the document itself exists.
    entityVersionId: safeUuid<"entityVersion">("entity_version_id").notNull(),
    blockId: p.varchar("block_id", { length: 128 }).notNull(),
    text: p.text().notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .uniqueIndex("document_review_reference_passages_version_block_uidx")
      .on(table.entityVersionId, table.blockId),
    p
      .foreignKey({
        columns: [table.organizationId],
        foreignColumns: [organization.id],
        name: "document_review_reference_passages_organization_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.workspaceId],
        foreignColumns: [workspaces.id],
        name: "document_review_reference_passages_workspace_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
        name: "document_review_reference_passages_entity_workspace_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "document_review_reference_passages_workspace_organization_fk",
      })
      .onDelete("cascade"),
    ...wsOrganizationPolicies("document_review_reference_passages"),
  ],
);
