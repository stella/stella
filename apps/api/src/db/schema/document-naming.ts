import { sql } from "drizzle-orm";

import {
  entityFeatureGateChecks,
  entityFeatureGateColumns,
} from "../entity-feature-gate-columns";
import {
  organization,
  p,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  timestamptz,
  wsOrganizationPolicies,
} from "./common";
import { workspaces } from "./contacts";
import { documentProcessingRuns } from "./document-processing";
import { entities, entityVersions } from "./entities";

export const DOCUMENT_NAMING_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type DocumentNamingStatus = (typeof DOCUMENT_NAMING_STATUSES)[number];

// The naming worker writes through the owner connection.
const isOwner = sql.raw(
  `current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.document_naming_runs'::regclass)`,
);

/**
 * One automatic rename of a newly uploaded document, from the organization's
 * naming pattern. Created when the document's first version gets text, in a
 * matter that opted in; PostgreSQL owns claiming and retries, and a BullMQ job
 * is only a wake-up.
 */
export const documentNamingRuns = p.pgTable(
  "document_naming_runs",
  {
    ...entityFeatureGateColumns(),
    /** The processing run that gave the document its text. */
    id: safeUuid<"documentProcessingRun">("id").primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    entityVersionId: safeUuid<"entityVersion">("entity_version_id").notNull(),
    /** The document's name when the run was created; a rename since wins. */
    sourceName: p.varchar("source_name", { length: 512 }).notNull(),
    status: p
      .text({ enum: DOCUMENT_NAMING_STATUSES })
      .notNull()
      .default("pending"),
    attempt: p.integer("attempt").notNull().default(0),
    claimedAt: timestamptz("claimed_at"),
    errorCode: p.varchar("error_code", { length: 128 }),
    /** A run refused for an exhausted action period waits for its end. */
    skippedUntil: timestamptz("skipped_until"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    ...entityFeatureGateChecks(table),
    p
      .foreignKey({
        columns: [table.id],
        foreignColumns: [documentProcessingRuns.id],
        name: "document_naming_runs_source_run_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.organizationId],
        foreignColumns: [organization.id],
        name: "document_naming_runs_organization_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.workspaceId],
        foreignColumns: [workspaces.id],
        name: "document_naming_runs_workspace_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "document_naming_runs_workspace_organization_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
        name: "document_naming_runs_entity_workspace_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.entityVersionId, table.entityId, table.workspaceId],
        foreignColumns: [
          entityVersions.id,
          entityVersions.entityId,
          entityVersions.workspaceId,
        ],
        name: "document_naming_runs_version_entity_workspace_fk",
      })
      .onDelete("cascade"),
    // A run holds a claim exactly while it is running.
    p.check(
      "document_naming_runs_claim_check",
      sql`(${table.status} = 'running') = (${table.claimedAt} IS NOT NULL)`,
    ),
    p
      .index("document_naming_runs_entity_workspace_idx")
      .on(table.entityId, table.workspaceId),
    // One automatic rename per document version, whichever run gave it text.
    p
      .uniqueIndex("document_naming_runs_version_entity_workspace_uidx")
      .on(table.entityVersionId, table.entityId, table.workspaceId),
    p
      .index("document_naming_runs_workspace_organization_idx")
      .on(table.workspaceId, table.organizationId),
    p
      .index("document_naming_runs_pending_idx")
      .on(table.updatedAt, table.id)
      .where(sql`${table.status} = 'pending'`),
    p
      .index("document_naming_runs_running_idx")
      .on(table.claimedAt, table.id)
      .where(sql`${table.status} = 'running'`),
    p.pgPolicy("document_naming_runs_owner", {
      for: "all",
      to: "public",
      using: isOwner,
      withCheck: isOwner,
    }),
    ...wsOrganizationPolicies("document_naming_runs", {
      columns: table,
      references: new Map([
        [
          table.entityVersionId,
          { target: "entity_versions", kind: "owned-content" },
        ],
        [table.entityId, { target: "entities", kind: "owned-content" }],
        [
          table.id,
          { kind: "owned-by-parent", parent: documentProcessingRuns },
        ],
      ]),
    }),
  ],
);
