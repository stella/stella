import type { DataExportPlanRecord } from "@/api/lib/data-export/archive-plan";
import { DATA_EXPORT_VERSION_SCOPE_VALUES } from "@/api/lib/data-export/version-scope";

import { reviewResetOwnerPolicies } from "../review-reset-policies";
import {
  jsonb,
  organization,
  orgPolicies,
  p,
  pUuid,
  safeOrganizationId,
  sql,
  timestamptz,
  user,
} from "./common";

export type { DataExportPlanRecord } from "@/api/lib/data-export/archive-plan";

/** Lifecycle of one organisation data export. `queued` on insert, `running`
 *  while the worker packs parts, then `ready` or `failed`; a `ready` export
 *  becomes `expired` once downloads close (the bucket lifecycle deletes the
 *  files). */
export const DATA_EXPORT_STATUSES = [
  "queued",
  "running",
  "ready",
  "failed",
  "expired",
] as const;
export type DataExportStatus = (typeof DATA_EXPORT_STATUSES)[number];

/** Statuses that hold the organisation's single export slot. */
export const ACTIVE_DATA_EXPORT_STATUSES = [
  "queued",
  "running",
] as const satisfies readonly DataExportStatus[];

/** Something that needs attention; mirrors the manifest's `problems`. */
export type DataExportProblemRecord =
  | { reason: "missing" | "fetch_failed"; path: string; fileId: string }
  | { reason: "matter_unavailable"; matterId: string }
  | {
      reason: "checksum_mismatch";
      path: string;
      fileId: string;
      recordedSha256: string;
    };

/** One finished part: the checkpoint a resumed run starts after. */
export type DataExportPartRecord = {
  index: number;
  /** The attempt whose upload holds this part's bytes. */
  attempt: number;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  matterIds: string[];
  fileCount: number;
  totals: {
    matters: number;
    documents: number;
    versions: number;
    files: number;
    fileBytes: number;
  };
  problems: DataExportProblemRecord[];
};

/** Failed attempts before an export is failed for good. A resume after a
 *  graceful shutdown is not a failure and does not count. */
export const DATA_EXPORT_MAX_FAILURES = 5;

const sqlValues = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql`, `,
  );

/**
 * The one-active-export index predicate as literal SQL. An `ON CONFLICT`
 * that names the partial index must repeat it with literals: a bound
 * parameter stops matching the index once Postgres switches to a generic
 * plan.
 */
export const ACTIVE_DATA_EXPORT_PREDICATE = sql`status IN (${sqlValues(ACTIVE_DATA_EXPORT_STATUSES)})`;

const DATA_EXPORT_OWNER_CHECK = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_data_exports'::regclass)`;

export const organizationDataExports = p.pgTable(
  "organization_data_exports",
  {
    id: pUuid<"dataExport">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Set null on account deletion: the export history outlives its requester.
    requestedBy: p
      .text("requested_by")
      .references(() => user.id, { onDelete: "set null" }),
    status: p
      .text("status", { enum: DATA_EXPORT_STATUSES })
      .notNull()
      .default("queued"),
    versionScope: p
      .text("version_scope", { enum: DATA_EXPORT_VERSION_SCOPE_VALUES })
      .notNull(),
    // Progress, planned from stored file sizes before packing starts.
    mattersTotal: p.integer("matters_total").notNull().default(0),
    mattersDone: p.integer("matters_done").notNull().default(0),
    bytesTotal: p
      .bigint("bytes_total", { mode: "number" })
      .notNull()
      .default(0),
    bytesDone: p.bigint("bytes_done", { mode: "number" }).notNull().default(0),
    partCount: p.integer("part_count"),
    // Fixed on the first attempt; null until then.
    plan: jsonb("plan").$type<DataExportPlanRecord>(),
    // Finished parts, appended as each one is committed: the checkpoint.
    parts: jsonb("parts").$type<DataExportPartRecord[]>().notNull().default([]),
    // Runs started for this export, resumes included. Fences run-owned
    // writes: a superseded run's attempt no longer matches.
    attempt: p.integer("attempt").notNull().default(0),
    // Attempts that ended in an error or a lost worker; bounded by
    // DATA_EXPORT_MAX_FAILURES.
    failures: p.integer("failures").notNull().default(0),
    // Files the manifest lists under `problems`.
    problemCount: p.integer("problem_count").notNull().default(0),
    error: p.text("error"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    startedAt: timestamptz("started_at"),
    // Bumped while the worker runs; a stale heartbeat marks a lost job.
    heartbeatAt: timestamptz("heartbeat_at"),
    completedAt: timestamptz("completed_at"),
    expiresAt: timestamptz("expires_at"),
  },
  (table) => [
    // One active export per organisation: the cost limit, enforced where a
    // concurrent request cannot race past it.
    p
      .uniqueIndex("organization_data_exports_one_active_uidx")
      .on(table.organizationId)
      .where(
        sql`${table.status} IN (${sqlValues(ACTIVE_DATA_EXPORT_STATUSES)})`,
      ),
    p
      .index("organization_data_exports_org_created_idx")
      .on(table.organizationId, table.createdAt.desc(), table.id.desc()),
    p.index("organization_data_exports_requested_by_idx").on(table.requestedBy),
    // Maintenance selects global status pages, independently of tenant size.
    p
      .index("organization_data_exports_status_expires_idx")
      .on(table.status, table.expiresAt, table.id),
    p
      .index("organization_data_exports_status_heartbeat_idx")
      .on(table.status, table.heartbeatAt, table.id),
    p
      .index("organization_data_exports_queued_requester_idx")
      .on(table.status, table.createdAt, table.id)
      .where(sql`${table.requestedBy} IS NOT NULL`),
    p
      .index("organization_data_exports_queued_abandoned_idx")
      .on(table.status, table.createdAt, table.id)
      .where(sql`${table.requestedBy} IS NULL`),
    p.check(
      "organization_data_exports_status_check",
      sql`${table.status} IN (${sqlValues(DATA_EXPORT_STATUSES)})`,
    ),
    p.check(
      "organization_data_exports_version_scope_check",
      sql`${table.versionScope} IN (${sqlValues(DATA_EXPORT_VERSION_SCOPE_VALUES)})`,
    ),
    ...orgPolicies(),
    // Row-level security is forced, so the table owner needs its own
    // policies: the review reset clears the table by organization, and the
    // maintenance sweep reads and updates exports across organizations.
    ...reviewResetOwnerPolicies("organization_data_exports"),
    p.pgPolicy("maintenance_owner_select", {
      for: "select",
      using: DATA_EXPORT_OWNER_CHECK,
    }),
    p.pgPolicy("maintenance_owner_update", {
      for: "update",
      using: DATA_EXPORT_OWNER_CHECK,
      withCheck: DATA_EXPORT_OWNER_CHECK,
    }),
  ],
);
