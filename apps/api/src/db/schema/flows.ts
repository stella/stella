import { sql } from "drizzle-orm";

import {
  FLOW_RUN_STATUSES,
  FLOW_RUN_STEP_STATUSES,
  FLOW_UPLOAD_TRIGGER_INTENT_STATUSES,
  FLOW_UPLOAD_TRIGGER_SKIP_REASONS,
} from "@/api/lib/flows/flow-types";
import type {
  FlowDefinitionSnapshot,
  FlowStep,
  FlowStepKind,
  FlowStepOutput,
  FlowTrigger,
  FlowTriggerSource,
} from "@/api/lib/flows/flow-types";

import {
  jsonb,
  orgPolicies,
  organizationOptionalWorkspacePolicies,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  user,
  wsPolicies,
  timestamptz,
} from "./common";
import { workspaces } from "./contacts";
import { entities } from "./entities";

// -- Flows (Workflows feature) --

/**
 * Org-scoped, reusable flow recipe: a linear list of typed `steps` plus
 * a `trigger` describing how runs are kicked off. Product name is
 * "Workflows"; internal name is `flow` to avoid colliding with the
 * extraction engine in `apps/api/src/lib/workflow/`.
 */
export const flowDefinitions = p.pgTable(
  "flow_definitions",
  {
    id: pUuid<"flowDefinition">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: p.varchar({ length: 256 }).notNull(),
    description: p.text(),
    steps: jsonb().$type<FlowStep[]>().notNull(),
    trigger: jsonb().$type<FlowTrigger>().notNull(),
    enabled: p.boolean().notNull().default(true),
    createdByUserId: p
      .text("created_by_user_id")
      .references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("flow_definitions_organization_id_idx").on(table.organizationId),
    p
      .index("flow_definitions_org_created_at_idx")
      .on(table.organizationId, table.createdAt),
    p.unique("flow_definitions_id_org_unq").on(table.id, table.organizationId),
    ...orgPolicies(),
  ],
);

/** Upload-trigger receipts commit with the document and survive admission pauses. */
const FLOW_UPLOAD_TRIGGER_UNSETTLED_STATUSES =
  FLOW_UPLOAD_TRIGGER_INTENT_STATUSES.filter((status) => status !== "skipped");

export const flowUploadTriggerIntents = p.pgTable(
  "flow_upload_trigger_intents",
  {
    definitionId: safeUuid<"flowDefinition">("definition_id").notNull(),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    fileExtension: p.text("file_extension"),
    status: p
      .text({ enum: FLOW_UPLOAD_TRIGGER_INTENT_STATUSES })
      .notNull()
      .default("pending"),
    skipReason: p.text("skip_reason", {
      enum: FLOW_UPLOAD_TRIGGER_SKIP_REASONS,
    }),
    retryAt: timestamptz("retry_at").notNull().defaultNow(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.primaryKey({ columns: [table.definitionId, table.entityId] }),
    p.check(
      "flow_upload_trigger_intents_settlement_check",
      sql`(${table.status} IN (${sql.join(
        FLOW_UPLOAD_TRIGGER_UNSETTLED_STATUSES.map((status) =>
          sql.raw(`'${status}'`),
        ),
        sql`, `,
      )}) AND ${table.skipReason} IS NULL) OR
        (${table.status} = 'skipped' AND ${table.skipReason} IS NOT NULL AND
          ${table.skipReason} IN (${sql.join(
            FLOW_UPLOAD_TRIGGER_SKIP_REASONS.map((reason) =>
              sql.raw(`'${reason}'`),
            ),
            sql`, `,
          )}))`,
    ),
    p
      .foreignKey({
        columns: [table.definitionId, table.organizationId],
        foreignColumns: [flowDefinitions.id, flowDefinitions.organizationId],
        name: "flow_upload_trigger_intents_definition_org_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
        name: "flow_upload_trigger_intents_entity_ws_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "flow_upload_trigger_intents_workspace_org_fk",
      })
      .onDelete("cascade"),
    p.index("flow_upload_trigger_intents_ws_idx").on(table.workspaceId),
    p
      .index("flow_upload_trigger_intents_retry_idx")
      .on(table.retryAt, table.definitionId, table.entityId)
      .where(sql`${table.status} = 'pending'`),
    p
      .index("flow_upload_trigger_intents_awaiting_grant_idx")
      .on(table.organizationId, table.workspaceId)
      .where(sql`${table.status} = 'awaiting_grant'`),
    ...organizationOptionalWorkspacePolicies("flow_upload_trigger_intents"),
  ],
);

/**
 * Workspace-scoped execution record for one flow run. `definitionSnapshot`
 * freezes {name, steps} at start so in-flight runs never read the live
 * definition. `inputEntityIds` are the documents the run operates on (no
 * FK: an array column, and run history should survive entity deletion).
 */
export const flowRuns = p.pgTable(
  "flow_runs",
  {
    id: pUuid<"flowRun">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Nullable + ON DELETE SET NULL: a run must outlive its definition.
    // `definitionSnapshot` makes an in-flight/historical run self-contained,
    // so deleting the definition nulls this reference rather than the run.
    definitionId: safeUuid<"flowDefinition">("definition_id").references(
      () => flowDefinitions.id,
      { onDelete: "set null" },
    ),
    definitionSnapshot: jsonb("definition_snapshot")
      .$type<FlowDefinitionSnapshot>()
      .notNull(),
    status: p.text({ enum: FLOW_RUN_STATUSES }).notNull().default("pending"),
    currentStepIndex: p.integer("current_step_index").notNull().default(0),
    triggerSource: jsonb("trigger_source").$type<FlowTriggerSource>().notNull(),
    inputEntityIds: safeUuid<"entity">("input_entity_ids")
      .array()
      .notNull()
      .default([]),
    error: p.text(),
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.check(
      "flow_runs_status_domain",
      sql`${table.status} IN (${sql.join(
        FLOW_RUN_STATUSES.map((status) => sql.raw(`'${status}'`)),
        sql`, `,
      )})`,
    ),
    p
      .index("flow_runs_ws_created_idx")
      .on(table.workspaceId, table.createdAt.desc(), table.id),
    p.index("flow_runs_definition_id_idx").on(table.definitionId),
    p
      .index("flow_runs_upload_identity_idx")
      .on(
        table.definitionId,
        table.workspaceId,
        sql`(${table.triggerSource}->>'entityId')`,
      )
      .where(sql`${table.triggerSource}->>'type' = 'file-upload'`),
    p
      .index("flow_runs_schedule_identity_idx")
      .on(
        table.definitionId,
        table.workspaceId,
        sql`(${table.triggerSource}->>'dueSlot')`,
      )
      .where(
        sql`${table.triggerSource}->>'type' = 'schedule' AND ${table.triggerSource}->>'dueSlot' IS NOT NULL`,
      ),
    p.unique("flow_runs_id_ws_unq").on(table.id, table.workspaceId),
    ...wsPolicies(),
  ],
);

/**
 * One step in a run. Denormalizes `workspaceId` and composite-FKs to
 * `(flowRuns.id, flowRuns.workspaceId)` so RLS scopes on its own
 * `workspace_id` (same pattern as `fields` / `justifications`), while the
 * composite FK guarantees a step can only reference a run in the same
 * workspace and cascades on run delete.
 */
export const flowRunSteps = p.pgTable(
  "flow_run_steps",
  {
    id: pUuid<"flowRunStep">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    runId: safeUuid<"flowRun">("run_id").notNull(),
    index: p.integer().notNull(),
    kind: p.text().$type<FlowStepKind>().notNull(),
    status: p
      .text({ enum: FLOW_RUN_STEP_STATUSES })
      .notNull()
      .default("pending"),
    output: jsonb().$type<FlowStepOutput>(),
    error: p.text(),
    /**
     * The task a review gate raises for its reviewer while the run waits.
     * Settling the gate settles the task and completing the task settles the
     * gate, so the two never disagree; only a `review-gate` step carries one.
     * A single-column reference: the tenant pair would need
     * `ON DELETE SET NULL (review_task_entity_id)`, which drizzle cannot
     * declare, and every lookup of this column carries the workspace
     * predicate.
     */
    reviewTaskEntityId: safeUuid<"entity">("review_task_entity_id").references(
      () => entities.id,
      { onDelete: "set null" },
    ),
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
  },
  (table) => [
    p.check(
      "flow_run_steps_status_domain",
      sql`${table.status} IN (${sql.join(
        FLOW_RUN_STEP_STATUSES.map((status) => sql.raw(`'${status}'`)),
        sql`, `,
      )})`,
    ),
    p
      .foreignKey({
        columns: [table.runId, table.workspaceId],
        foreignColumns: [flowRuns.id, flowRuns.workspaceId],
      })
      .onDelete("cascade"),
    p.uniqueIndex("flow_run_steps_run_index_key").on(table.runId, table.index),
    p
      .uniqueIndex("flow_run_steps_review_task_entity_key")
      .on(table.workspaceId, table.reviewTaskEntityId)
      .where(sql`${table.reviewTaskEntityId} IS NOT NULL`),
    p.index("flow_run_steps_workspace_id_idx").on(table.workspaceId),
    ...wsPolicies(),
  ],
);
