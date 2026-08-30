import {
  SIGNAL_KINDS,
  SIGNAL_KIND_ORIGIN,
  SIGNAL_ORIGINS,
  SIGNAL_SEVERITIES,
  SIGNAL_STATUSES,
} from "@stll/api-contract/signals";
import type {
  SignalEvidence,
  SignalSubject,
  SignalSuggestion,
  SUGGESTION_KIND,
} from "@stll/api-contract/signals";

import {
  jsonb,
  organization,
  organizationCheck,
  organizationOptionalWorkspacePolicies,
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
} from "./common";
import { workspaces } from "./contacts";

export const SIGNAL_EVENT_TYPE = {
  CREATED: "created",
  SNOOZED: "snoozed",
  UNSNOOZED: "unsnoozed",
  ACCEPTED: "accepted",
  DISMISSED: "dismissed",
  ASSIGNED: "assigned",
} as const;
export type SignalEventType =
  (typeof SIGNAL_EVENT_TYPE)[keyof typeof SIGNAL_EVENT_TYPE];
export const SIGNAL_EVENT_TYPES = [
  SIGNAL_EVENT_TYPE.CREATED,
  SIGNAL_EVENT_TYPE.SNOOZED,
  SIGNAL_EVENT_TYPE.UNSNOOZED,
  SIGNAL_EVENT_TYPE.ACCEPTED,
  SIGNAL_EVENT_TYPE.DISMISSED,
  SIGNAL_EVENT_TYPE.ASSIGNED,
] as const satisfies readonly SignalEventType[];

/** What an accepted suggestion produced, for provenance from the result back. */
export type SignalAcceptedResult =
  | {
      suggestionKind:
        | typeof SUGGESTION_KIND.CREATE_DEADLINE
        | typeof SUGGESTION_KIND.CREATE_TASK;
      result: { type: "entity"; entityId: string; workspaceId: string };
    }
  | {
      suggestionKind: typeof SUGGESTION_KIND.PROMOTE_TO_WORKSPACE;
      result: { type: "workspace"; workspaceId: string };
    }
  | {
      suggestionKind:
        | typeof SUGGESTION_KIND.ASSIGN
        | typeof SUGGESTION_KIND.OPEN_CHAT;
      result: { type: "none" };
    };

const SIGNAL_STATUS_SQL_VALUES = SIGNAL_STATUSES.map((status) =>
  sql.raw(`'${status}'`),
);
const SIGNAL_KIND_SQL_VALUES = SIGNAL_KINDS.map((kind) => sql.raw(`'${kind}'`));
const SIGNAL_ORIGIN_SQL_VALUES = SIGNAL_ORIGINS.map((origin) =>
  sql.raw(`'${origin}'`),
);
const SIGNAL_SEVERITY_SQL_VALUES = SIGNAL_SEVERITIES.map((severity) =>
  sql.raw(`'${severity}'`),
);
const SIGNAL_KIND_ORIGIN_SQL = SIGNAL_KINDS.map((kind) =>
  sql.raw(`("kind" = '${kind}' AND "origin" = '${SIGNAL_KIND_ORIGIN[kind]}')`),
);
const SIGNAL_EVENT_TYPE_SQL_VALUES = SIGNAL_EVENT_TYPES.map((type) =>
  sql.raw(`'${type}'`),
);

export const SCOUT_RUN_STATUS = {
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
} as const;
export type ScoutRunStatus =
  (typeof SCOUT_RUN_STATUS)[keyof typeof SCOUT_RUN_STATUS];
export const SCOUT_RUN_STATUSES = [
  SCOUT_RUN_STATUS.RUNNING,
  SCOUT_RUN_STATUS.SUCCEEDED,
  SCOUT_RUN_STATUS.FAILED,
] as const satisfies readonly ScoutRunStatus[];
const SCOUT_RUN_STATUS_SQL_VALUES = SCOUT_RUN_STATUSES.map((status) =>
  sql.raw(`'${status}'`),
);

/**
 * Org-scoped inbox signal. `workspaceId` NULL means unscoped (triage):
 * visible only to members with the `signal:triage` permission. RLS pins the
 * organization for every row and additionally requires workspace access when
 * the signal is scoped; handlers enforce the triage permission.
 *
 * `dedupeKey` makes scouts replay-safe: re-emitting the same observation is
 * an `ON CONFLICT DO NOTHING`.
 */
export const signals = p.pgTable(
  "signals",
  {
    id: pUuid<"signal">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id").references(
      () => workspaces.id,
      { onDelete: "cascade" },
    ),
    kind: p.text({ enum: SIGNAL_KINDS }).notNull(),
    origin: p.text({ enum: SIGNAL_ORIGINS }).notNull(),
    scoutKey: p.text("scout_key").notNull(),
    severity: p.text({ enum: SIGNAL_SEVERITIES }).notNull(),
    /** 0..1, model origin only. */
    confidence: p.real(),
    title: p.varchar({ length: 512 }).notNull(),
    summary: p.text().notNull(),
    subject: jsonb().$type<SignalSubject>().notNull(),
    evidence: jsonb().$type<SignalEvidence>().notNull(),
    suggestions: jsonb().$type<SignalSuggestion[]>().notNull(),
    dedupeKey: p.text("dedupe_key").notNull(),
    status: p.text({ enum: SIGNAL_STATUSES }).notNull().default("new"),
    snoozedUntil: timestamptz("snoozed_until"),
    assigneeUserId: p
      .text("assignee_user_id")
      .references(() => user.id, { onDelete: "set null" }),
    createdByUserId: p
      .text("created_by_user_id")
      .references(() => user.id, { onDelete: "set null" }),
    dismissReason: p.text("dismiss_reason"),
    acceptedResult: jsonb("accepted_result").$type<SignalAcceptedResult>(),
    resolvedAt: timestamptz("resolved_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "signals_workspace_organization_fk",
      })
      .onDelete("cascade"),
    p.unique("signals_id_org_unq").on(table.id, table.organizationId),
    p
      .uniqueIndex("signals_org_dedupe_uidx")
      .on(table.organizationId, table.dedupeKey),
    p
      .index("signals_org_status_created_idx")
      .on(table.organizationId, table.status, table.createdAt.desc(), table.id),
    p
      .index("signals_ws_status_created_idx")
      .on(table.workspaceId, table.status, table.createdAt.desc(), table.id),
    p.index("signals_assignee_idx").on(table.assigneeUserId, table.status),
    p.index("signals_created_by_user_idx").on(table.createdByUserId),
    p.check(
      "signals_kind_check",
      sql`${table.kind} in (${sql.join(SIGNAL_KIND_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "signals_origin_check",
      sql`${table.origin} in (${sql.join(SIGNAL_ORIGIN_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "signals_severity_check",
      sql`${table.severity} in (${sql.join(SIGNAL_SEVERITY_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "signals_kind_origin_check",
      sql`(${sql.join(SIGNAL_KIND_ORIGIN_SQL, sql` OR `)})`,
    ),
    p.check(
      "signals_confidence_range",
      sql`${table.confidence} is null or (${table.confidence} >= 0 and ${table.confidence} <= 1)`,
    ),
    p.check(
      "signals_model_has_confidence",
      sql`${table.origin} <> 'model' or ${table.confidence} is not null`,
    ),
    p.check(
      "signals_status_check",
      sql`${table.status} in (${sql.join(SIGNAL_STATUS_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "signals_lifecycle_check",
      sql`(
        (${table.status} = 'new'
          AND ${table.snoozedUntil} IS NULL
          AND ${table.resolvedAt} IS NULL
          AND ${table.acceptedResult} IS NULL
          AND ${table.dismissReason} IS NULL)
        OR (${table.status} = 'snoozed'
          AND ${table.snoozedUntil} IS NOT NULL
          AND ${table.resolvedAt} IS NULL
          AND ${table.acceptedResult} IS NULL
          AND ${table.dismissReason} IS NULL)
        OR (${table.status} = 'accepted'
          AND ${table.snoozedUntil} IS NULL
          AND ${table.resolvedAt} IS NOT NULL
          AND ${table.acceptedResult} IS NOT NULL
          AND ${table.dismissReason} IS NULL)
        OR (${table.status} = 'dismissed'
          AND ${table.snoozedUntil} IS NULL
          AND ${table.resolvedAt} IS NOT NULL
          AND ${table.acceptedResult} IS NULL)
      )`,
    ),
    ...organizationOptionalWorkspacePolicies("signals"),
  ],
);

/** Append-only lifecycle audit for a signal. */
export const signalEvents = p.pgTable(
  "signal_events",
  {
    id: pUuid<"signalEvent">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    signalId: safeUuid<"signal">("signal_id").notNull(),
    type: p.text({ enum: SIGNAL_EVENT_TYPES }).notNull(),
    actorUserId: p
      .text("actor_user_id")
      .references(() => user.id, { onDelete: "set null" }),
    payload: jsonb().$type<Record<string, unknown>>(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => {
    const parentSignalVisible = sql`(
      ${organizationCheck}
      AND EXISTS (
        SELECT 1
        FROM ${signals}
        WHERE ${signals.id} = ${table.signalId}
          AND ${signals.organizationId} = ${table.organizationId}
      )
    )`;

    return [
      p
        .foreignKey({
          columns: [table.signalId, table.organizationId],
          foreignColumns: [signals.id, signals.organizationId],
          name: "signal_events_signal_fk",
        })
        .onDelete("cascade"),
      p
        .index("signal_events_signal_created_idx")
        .on(table.signalId, table.createdAt),
      p.index("signal_events_actor_user_idx").on(table.actorUserId),
      p.check(
        "signal_events_type_check",
        sql`${table.type} in (${sql.join(SIGNAL_EVENT_TYPE_SQL_VALUES, sql`, `)})`,
      ),
      p.pgPolicy("signal_events_select", {
        for: "select",
        to: stella,
        using: parentSignalVisible,
      }),
      p.pgPolicy("signal_events_insert", {
        for: "insert",
        to: stella,
        withCheck: parentSignalVisible,
      }),
      p.pgPolicy("signal_events_no_update", {
        as: "restrictive",
        for: "update",
        to: stella,
        using: sql`false`,
      }),
      p.pgPolicy("signal_events_no_delete", {
        as: "restrictive",
        for: "delete",
        to: stella,
        using: sql`false`,
      }),
    ];
  },
);

/**
 * Census of scout executions: proves a scout ran and how many signals it
 * emitted vs. deduplicated, so "no signals" is distinguishable from "never
 * ran".
 */
export const scoutRuns = p.pgTable(
  "scout_runs",
  {
    id: pUuid<"scoutRun">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    scoutKey: p.text("scout_key").notNull(),
    status: p.text({ enum: SCOUT_RUN_STATUSES }).notNull(),
    emittedCount: p.integer("emitted_count").notNull().default(0),
    insertedCount: p.integer("inserted_count").notNull().default(0),
    error: p.text(),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    finishedAt: timestamptz("finished_at"),
  },
  (table) => [
    p
      .index("scout_runs_org_scout_started_idx")
      .on(table.organizationId, table.scoutKey, table.startedAt.desc()),
    p
      .index("scout_runs_running_scout_started_idx")
      .on(table.scoutKey, table.startedAt, table.id)
      .where(sql`${table.status} = 'running'`),
    p.check(
      "scout_runs_status_check",
      sql`${table.status} in (${sql.join(SCOUT_RUN_STATUS_SQL_VALUES, sql`, `)})`,
    ),
    ...orgPolicies(),
  ],
);
