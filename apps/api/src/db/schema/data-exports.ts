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

/** Lifecycle of one organisation data export. `queued` on insert, `running`
 *  while the worker packs parts, then `ready` or `failed`; a `ready` export
 *  becomes `expired` once its files are deleted. */
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

/** Which document versions the export carries; mirrors the manifest's
 *  `scope.versions`. */
export const DATA_EXPORT_VERSION_SCOPE_VALUES = ["all", "current"] as const;

/** A file that needs attention; mirrors the manifest's `problems`. */
export type DataExportProblemRecord =
  | { reason: "missing" | "fetch_failed"; path: string; fileId: string }
  | {
      reason: "checksum_mismatch";
      path: string;
      fileId: string;
      recordedSha256: string;
    };

/** One finished part: the checkpoint a resumed run starts after. */
export type DataExportPartRecord = {
  index: number;
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

/** The fixed split into parts, so every attempt packs the same parts. */
export type DataExportPlanRecord = {
  parts: { index: number; matterIds: string[]; estimatedBytes: number }[];
  mattersTotal: number;
  bytesTotal: number;
};

/** Attempts (first run plus resumes) before an export is failed for good. */
export const DATA_EXPORT_MAX_ATTEMPTS = 5;

const sqlValues = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql`, `,
  );

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
    // Runs started for this export; a resume after a restart is one more.
    attempts: p.integer("attempts").notNull().default(0),
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
    p
      .index("organization_data_exports_ready_expires_idx")
      .on(table.expiresAt)
      .where(sql`${table.status} = 'ready'`),
    p.check(
      "organization_data_exports_status_check",
      sql`${table.status} IN (${sqlValues(DATA_EXPORT_STATUSES)})`,
    ),
    p.check(
      "organization_data_exports_version_scope_check",
      sql`${table.versionScope} IN (${sqlValues(DATA_EXPORT_VERSION_SCOPE_VALUES)})`,
    ),
    ...orgPolicies(),
  ],
);
