import {
  WORK_OBLIGATION_STATUS,
  WORK_OBLIGATION_STATUSES,
} from "@stll/api-contract/workflow-status";
import type { WorkObligationStatus } from "@stll/api-contract/workflow-status";

import {
  isNotNull,
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
import { entities } from "./entities";

export const WORK_OBLIGATION_TYPE = {
  TASK: "task",
  DEADLINE: "deadline",
} as const;

export const WORK_OBLIGATION_TYPES = [
  WORK_OBLIGATION_TYPE.TASK,
  WORK_OBLIGATION_TYPE.DEADLINE,
] as const;
export type WorkObligationType = (typeof WORK_OBLIGATION_TYPES)[number];

export {
  WORK_OBLIGATION_STATUS,
  WORK_OBLIGATION_STATUSES,
} from "@stll/api-contract/workflow-status";
export type { WorkObligationStatus } from "@stll/api-contract/workflow-status";

export const WORK_OBLIGATION_SOURCE = {
  MANUAL: "manual",
  CALENDAR: "calendar",
  EMAIL: "email",
  DOCUMENT: "document",
  COURT: "court",
  IMPORT: "import",
  API: "api",
  /** A workflow run waiting at a review gate for the owner's decision. */
  FLOW: "flow",
} as const;

export const WORK_OBLIGATION_SOURCES = [
  WORK_OBLIGATION_SOURCE.MANUAL,
  WORK_OBLIGATION_SOURCE.CALENDAR,
  WORK_OBLIGATION_SOURCE.EMAIL,
  WORK_OBLIGATION_SOURCE.DOCUMENT,
  WORK_OBLIGATION_SOURCE.COURT,
  WORK_OBLIGATION_SOURCE.IMPORT,
  WORK_OBLIGATION_SOURCE.API,
  WORK_OBLIGATION_SOURCE.FLOW,
] as const;
export type WorkObligationSource = (typeof WORK_OBLIGATION_SOURCES)[number];

export const WORK_OBLIGATION_EVENT_TYPE = {
  CREATED: "created",
  OWNER_ASSIGNED: "owner_assigned",
  ACKNOWLEDGED: "acknowledged",
  DELEGATED: "delegated",
  WORKING_TARGET_CHANGED: "working_target_changed",
  HARD_DEADLINE_CHANGED: "hard_deadline_changed",
  TYPE_CHANGED: "type_changed",
  PROVENANCE_CHANGED: "provenance_changed",
  COMPLETED: "completed",
  REOPENED: "reopened",
  CANCELLED: "cancelled",
} as const;

export const WORK_OBLIGATION_EVENT_TYPES = [
  WORK_OBLIGATION_EVENT_TYPE.CREATED,
  WORK_OBLIGATION_EVENT_TYPE.OWNER_ASSIGNED,
  WORK_OBLIGATION_EVENT_TYPE.ACKNOWLEDGED,
  WORK_OBLIGATION_EVENT_TYPE.DELEGATED,
  WORK_OBLIGATION_EVENT_TYPE.WORKING_TARGET_CHANGED,
  WORK_OBLIGATION_EVENT_TYPE.HARD_DEADLINE_CHANGED,
  WORK_OBLIGATION_EVENT_TYPE.TYPE_CHANGED,
  WORK_OBLIGATION_EVENT_TYPE.PROVENANCE_CHANGED,
  WORK_OBLIGATION_EVENT_TYPE.COMPLETED,
  WORK_OBLIGATION_EVENT_TYPE.REOPENED,
  WORK_OBLIGATION_EVENT_TYPE.CANCELLED,
] as const;
export type WorkObligationEventType =
  (typeof WORK_OBLIGATION_EVENT_TYPES)[number];

export type WorkObligationEventDetails =
  // `legacy_backfill` marks work derived from a pre-governance task rather than
  // created through a governed flow: the row has no earlier history to show.
  | { type: "created"; cause?: "legacy_backfill" }
  | {
      type: "ownership_changed";
      previousOwnerUserId: string | null;
      nextOwnerUserId: string | null;
      cause?: "account_deletion" | "owner_removed_from_workspace";
    }
  | { type: "acknowledged" }
  | {
      type: "date_changed";
      field: "working_target_date" | "hard_deadline_date";
      previousDate: string | null;
      nextDate: string | null;
    }
  | {
      type: "obligation_type_changed";
      previousType: WorkObligationType;
      nextType: WorkObligationType;
    }
  | {
      type: "provenance_changed";
      previousSourceType: WorkObligationSource;
      nextSourceType: WorkObligationSource;
      previousSourceEntityId: string | null;
      nextSourceEntityId: string | null;
    }
  | {
      type: "status_changed";
      previousStatus: WorkObligationStatus;
      nextStatus: WorkObligationStatus;
    };

const WORK_OBLIGATION_TYPE_SQL_VALUES = WORK_OBLIGATION_TYPES.map((type) =>
  sql.raw(`'${type}'`),
);

const WORK_OBLIGATION_STATUS_SQL_VALUES = WORK_OBLIGATION_STATUSES.map(
  (status) => sql.raw(`'${status}'`),
);

/** Closed obligations: the owner and acknowledgement invariants no longer hold. */
const WORK_OBLIGATION_TERMINAL_STATUSES = [
  WORK_OBLIGATION_STATUS.COMPLETED,
  WORK_OBLIGATION_STATUS.CANCELLED,
] as const satisfies readonly WorkObligationStatus[];

const WORK_OBLIGATION_TERMINAL_STATUS_SQL_VALUES =
  WORK_OBLIGATION_TERMINAL_STATUSES.map((status) => sql.raw(`'${status}'`));

const WORK_OBLIGATION_SOURCE_SQL_VALUES = WORK_OBLIGATION_SOURCES.map(
  (source) => sql.raw(`'${source}'`),
);

const WORK_OBLIGATION_EVENT_TYPE_SQL_VALUES = WORK_OBLIGATION_EVENT_TYPES.map(
  (type) => sql.raw(`'${type}'`),
);

/**
 * Governed operational state for a task entity. The entity remains the public
 * task record; this one-to-one row adds accountability and deadline semantics
 * without creating a competing task store.
 */
export const workObligations = p.pgTable(
  "work_obligations",
  {
    entityId: safeUuid<"entity">("entity_id").primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    type: p
      .text("type", { enum: WORK_OBLIGATION_TYPES })
      .notNull()
      .default(WORK_OBLIGATION_TYPE.TASK),
    status: p
      .text("status", { enum: WORK_OBLIGATION_STATUSES })
      .notNull()
      .default(WORK_OBLIGATION_STATUS.UNASSIGNED),
    ownerUserId: p
      .text("owner_user_id")
      .references(() => user.id, { onDelete: "set null" }),
    acknowledgedAt: timestamptz("acknowledged_at"),
    acknowledgedByUserId: p
      .text("acknowledged_by_user_id")
      .references(() => user.id, { onDelete: "set null" }),
    workingTargetDate: p.date("working_target_date", { mode: "string" }),
    hardDeadlineDate: p.date("hard_deadline_date", { mode: "string" }),
    sourceType: p
      .text("source_type", { enum: WORK_OBLIGATION_SOURCES })
      .notNull()
      .default(WORK_OBLIGATION_SOURCE.MANUAL),
    sourceEntityId: safeUuid<"entity">("source_entity_id").references(
      () => entities.id,
      { onDelete: "set null" },
    ),
    sourceDescription: p.varchar("source_description", { length: 1000 }),
    createdByUserId: p
      .text("created_by_user_id")
      .references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .unique("work_obligations_entity_ws_unq")
      .on(table.entityId, table.workspaceId),
    p
      .foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
      })
      .onDelete("cascade"),
    p.foreignKey({
      columns: [table.sourceEntityId, table.workspaceId],
      foreignColumns: [entities.id, entities.workspaceId],
      name: "work_obligations_source_entity_workspace_fk",
    }),
    p.check(
      "work_obligations_type_check",
      sql`${table.type} IN (${sql.join(WORK_OBLIGATION_TYPE_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "work_obligations_status_check",
      sql`${table.status} IN (${sql.join(WORK_OBLIGATION_STATUS_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "work_obligations_source_type_check",
      sql`${table.sourceType} IN (${sql.join(WORK_OBLIGATION_SOURCE_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "work_obligations_target_before_deadline_check",
      sql`${table.workingTargetDate} IS NULL OR ${table.hardDeadlineDate} IS NULL OR ${table.workingTargetDate} <= ${table.hardDeadlineDate}`,
    ),
    p.check(
      "work_obligations_acknowledgement_pair_check",
      sql`(${table.acknowledgedAt} IS NULL) = (${table.acknowledgedByUserId} IS NULL)`,
    ),
    p.check(
      "work_obligations_state_coherence_check",
      sql`(${table.status} = 'unassigned' AND ${table.ownerUserId} IS NULL AND ${table.acknowledgedAt} IS NULL) OR (${table.status} = 'awaiting_acknowledgement' AND ${table.ownerUserId} IS NOT NULL AND ${table.acknowledgedAt} IS NULL) OR (${table.status} = 'active' AND ${table.ownerUserId} IS NOT NULL AND ${table.acknowledgedAt} IS NOT NULL AND ${table.acknowledgedByUserId} = ${table.ownerUserId}) OR ${table.status} IN (${sql.join(WORK_OBLIGATION_TERMINAL_STATUS_SQL_VALUES, sql`, `)})`,
    ),
    p
      .index("work_obligations_ws_owner_status_target_entity_idx")
      .on(
        table.workspaceId,
        table.ownerUserId,
        table.status,
        table.workingTargetDate,
        table.entityId,
      ),
    p
      .index("work_obligations_owner_status_due_entity_ws_idx")
      .on(
        table.ownerUserId,
        table.status,
        sql`COALESCE(${table.hardDeadlineDate}, ${table.workingTargetDate}, '9999-12-31'::date)`,
        table.entityId,
        table.workspaceId,
      ),
    p
      .index("work_obligations_ws_status_deadline_entity_idx")
      .on(
        table.workspaceId,
        table.status,
        table.hardDeadlineDate,
        table.entityId,
      )
      .where(isNotNull(table.hardDeadlineDate)),
    ...wsPolicies(),
  ],
);

/** Human-readable, immutable operational history. */
export const workObligationEvents = p.pgTable(
  "work_obligation_events",
  {
    id: pUuid<"workObligationEvent">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    obligationEntityId: safeUuid<"entity">("obligation_entity_id").notNull(),
    actorUserId: p
      .text("actor_user_id")
      .references(() => user.id, { onDelete: "set null" }),
    type: p.text("type", { enum: WORK_OBLIGATION_EVENT_TYPES }).notNull(),
    details: jsonb("details").$type<WorkObligationEventDetails>().notNull(),
    reason: p.varchar("reason", { length: 1000 }),
    occurredAt: timestamptz("occurred_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .foreignKey({
        columns: [table.obligationEntityId, table.workspaceId],
        foreignColumns: [workObligations.entityId, workObligations.workspaceId],
      })
      .onDelete("cascade"),
    p.check(
      "work_obligation_events_type_check",
      sql`${table.type} IN (${sql.join(WORK_OBLIGATION_EVENT_TYPE_SQL_VALUES, sql`, `)})`,
    ),
    p
      .index("work_obligation_events_ws_obligation_occurred_id_idx")
      .on(
        table.workspaceId,
        table.obligationEntityId,
        table.occurredAt,
        table.id,
      ),
    p.pgPolicy("work_obligation_events_select", {
      for: "select",
      to: stella,
      using: workspaceCheck,
    }),
    p.pgPolicy("work_obligation_events_insert", {
      for: "insert",
      to: stella,
      withCheck: workspaceCheck,
    }),
    p.pgPolicy("work_obligation_events_no_update", {
      as: "restrictive",
      for: "update",
      to: stella,
      using: sql`false`,
    }),
    p.pgPolicy("work_obligation_events_no_delete", {
      as: "restrictive",
      for: "delete",
      to: stella,
      using: sql`false`,
    }),
  ],
);
