import { sql } from "drizzle-orm";

import {
  organization,
  p,
  pUuid,
  safeOrganizationId,
  safeWorkspaceId,
  user,
  wsOrganizationReadOnlyPolicies,
  timestamptz,
} from "./common";
import { workspaces } from "./contacts";

export const EXTRACTION_RUN_STATUSES = [
  "planning",
  "running",
  "finalizing",
  "completed",
  "failed",
  "skipped",
] as const;
export type ExtractionRunStatus = (typeof EXTRACTION_RUN_STATUSES)[number];

export const EXTRACTION_RUN_SCOPES = [
  "workspace",
  "entities",
  "properties",
  "cells",
] as const;
export type ExtractionRunScope = (typeof EXTRACTION_RUN_SCOPES)[number];

const EXTRACTION_RUN_STATUS_SQL_VALUES = EXTRACTION_RUN_STATUSES.map((status) =>
  sql.raw(`'${status}'`),
);

const EXTRACTION_RUN_SCOPE_SQL_VALUES = EXTRACTION_RUN_SCOPES.map((scope) =>
  sql.raw(`'${scope}'`),
);

/**
 * Durable lifecycle metadata for tabular-review extraction. Redis and BullMQ
 * remain the hot execution path; this row is the tenant-scoped source for run
 * history, coarse progress, terminal state, and recovery diagnostics. It never
 * stores prompts, source material, generated answers, or document identifiers.
 */
export const extractionRuns = p.pgTable(
  "extraction_runs",
  {
    id: pUuid<"extractionRun">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requestedBy: p
      .text("requested_by")
      .references(() => user.id, { onDelete: "set null" }),
    scope: p.text({ enum: EXTRACTION_RUN_SCOPES }).notNull(),
    executionVersion: p.integer("execution_version").notNull().default(1),
    status: p
      .text({ enum: EXTRACTION_RUN_STATUSES })
      .notNull()
      .default("planning"),
    total: p.integer().notNull().default(0),
    completed: p.integer().notNull().default(0),
    errorCode: p.varchar("error_code", { length: 128 }),
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .index("extraction_runs_workspace_created_idx")
      .on(table.workspaceId, table.createdAt.desc(), table.id),
    p
      .index("extraction_runs_active_updated_idx")
      .on(table.updatedAt, table.workspaceId)
      .where(sql`${table.status} IN ('planning', 'running', 'finalizing')`),
    p.check(
      "extraction_runs_execution_version_positive_check",
      sql`${table.executionVersion} > 0`,
    ),
    p.check(
      "extraction_runs_scope_values_check",
      sql`${table.scope} IN (${sql.join(EXTRACTION_RUN_SCOPE_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "extraction_runs_status_values_check",
      sql`${table.status} IN (${sql.join(EXTRACTION_RUN_STATUS_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "extraction_runs_progress_nonnegative_check",
      sql`${table.total} >= 0 AND ${table.completed} >= 0`,
    ),
    p.check(
      "extraction_runs_completed_within_total_check",
      sql`${table.completed} <= ${table.total}`,
    ),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "extraction_runs_workspace_organization_fk",
      })
      .onDelete("cascade"),
    ...wsOrganizationReadOnlyPolicies("extraction_runs"),
  ],
);
