import { sql } from "drizzle-orm";

import {
  jsonb,
  p,
  pUuid,
  safeUuid,
  safeWorkspaceId,
  user,
  wsPolicies,
  timestamptz,
} from "./common";
import type { AnyPgColumn, SafeId, ViewLayout } from "./common";
import { workspaces } from "./contacts";
import { entities, fields } from "./entities";
import { workspaceViews } from "./files-views";

/** Lifecycle of one view->report export job. `queued` on insert, `running`
 *  while the worker fills the template, then a terminal `completed`/`failed`. */
export const REPORT_EXPORT_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
] as const;
export type ReportExportStatus = (typeof REPORT_EXPORT_STATUSES)[number];

/** Delivery mode chosen at export time. `workspace` also creates a document
 *  entity (opens in folio, versioned); `download` only stores the DOCX under a
 *  lifecycle-expired exports prefix and the status endpoint hands back a
 *  presigned URL. Both always write the bytes to S3. */
export const REPORT_EXPORT_MODES = ["workspace", "download"] as const;
export type ReportExportMode = (typeof REPORT_EXPORT_MODES)[number];

/** Delivery format chosen at export time. The fill pipeline always builds a
 *  DOCX; `pdf` converts it before delivery. Persisted (rather than carried on
 *  the job alone) so an export whose job the queue lost can be rebuilt from
 *  the row. */
export const REPORT_EXPORT_FORMATS = ["docx", "pdf"] as const;
export type ReportExportFormat = (typeof REPORT_EXPORT_FORMATS)[number];

/** The CHECK the database enforces is built from the value list above, so a
 *  new format cannot widen the type without widening the constraint. */
const REPORT_EXPORT_FORMAT_SQL_VALUES = sql.join(
  REPORT_EXPORT_FORMATS.map((value) => sql.raw(`'${value}'`)),
  sql`, `,
);

/** At-most-once delivery state for the export's privacy-safe status email.
 *  `sending` is claimed atomically before the external call, so a crash may
 *  omit an email but can never duplicate one. Historical rows default to
 *  `suppressed` and are not backfilled into an outbound-email flood. */
export const REPORT_EXPORT_NOTIFICATION_STATUSES = [
  "suppressed",
  "pending",
  "sending",
  "sent",
  "delivery_failed",
] as const;
export type ReportExportNotificationStatus =
  (typeof REPORT_EXPORT_NOTIFICATION_STATUSES)[number];

/** Which template the export fills: a deployment built-in resolved by key, or
 *  a stored org template (filled at its current version). No UUIDs reach the
 *  AI-visible report data; this ref is job metadata, not report content. */
export type ReportTemplateRef =
  | { type: "builtin"; key: string }
  | { type: "stored"; templateId: SafeId<"template"> };

export const reportExports = p.pgTable(
  "report_exports",
  {
    id: pUuid<"reportExport">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Nullable + set-null on user delete: mirrors entities.createdBy so an
    // account deletion is never blocked by an old export record.
    requestedBy: p
      .text("requested_by")
      .references(() => user.id, { onDelete: "set null" }),
    templateRef: jsonb("template_ref").$type<ReportTemplateRef>().notNull(),
    // The source view, when the export came from a saved view. Nullable FK
    // (set null if the view is later deleted); the layout snapshot below keeps
    // the job self-contained regardless.
    viewId: safeUuid<"workspaceView">("view_id").references(
      (): AnyPgColumn => workspaceViews.id,
      { onDelete: "set null" },
    ),
    // Snapshot of the layout inputs the report was built from (filters, sorts,
    // column order, hidden columns), so the worker is deterministic even if the
    // view changes or is deleted between enqueue and run.
    layout: jsonb().$type<ViewLayout>().notNull(),
    status: p
      .text("status", { enum: REPORT_EXPORT_STATUSES })
      .notNull()
      .default("queued"),
    mode: p.text("mode", { enum: REPORT_EXPORT_MODES }).notNull(),
    // The request the job was built from. Without these two the worker's
    // payload is the only record of what was asked for, so a job the queue
    // lost cannot be re-enqueued from the row.
    //
    // Nullable with no default, and null only on rows written before the
    // columns existed: those exports carried their request on the job alone,
    // so any default here would be a guess the reconciler would then act on.
    // Null means "the request was never recorded", which the sweep fails
    // rather than rebuilds. Every write sets both.
    format: p.text("format", { enum: REPORT_EXPORT_FORMATS }),
    aiNarrative: p.boolean("ai_narrative"),
    error: p.text("error"),
    resultEntityId: safeUuid<"entity">("result_entity_id").references(
      (): AnyPgColumn => entities.id,
      { onDelete: "set null" },
    ),
    // The exact file field created with a workspace-mode export. Retaining it
    // avoids re-resolving a mutable entity/version when opening the result.
    resultFieldId: safeUuid<"field">("result_field_id").references(
      (): AnyPgColumn => fields.id,
      { onDelete: "set null" },
    ),
    resultS3Key: p.varchar("result_s3_key", { length: 512 }),
    notificationStatus: p
      .text("notification_status", {
        enum: REPORT_EXPORT_NOTIFICATION_STATUSES,
      })
      .notNull()
      .default("suppressed"),
    notificationLang: p
      .varchar("notification_lang", { length: 10 })
      .notNull()
      .default("en"),
    notificationAttemptedAt: timestamptz("notification_attempted_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .index("report_exports_workspace_created_idx")
      .on(table.workspaceId, table.createdAt, table.id),
    p
      .index("report_exports_workspace_requester_created_idx")
      .on(table.workspaceId, table.requestedBy, table.createdAt, table.id),
    p.index("report_exports_result_field_idx").on(table.resultFieldId),
    // The reconciler's keyset walk over exports still waiting for a worker.
    p
      .index("report_exports_queued_idx")
      .on(table.createdAt, table.id)
      .where(sql`${table.status} = 'queued'`),
    p.check(
      "report_exports_format_values_check",
      sql`${table.format} IS NULL OR ${table.format} IN (${REPORT_EXPORT_FORMAT_SQL_VALUES})`,
    ),
    p
      .index("report_exports_pending_notification_idx")
      .on(table.createdAt, table.id)
      .where(
        sql`${table.notificationStatus} = 'pending' AND ${table.status} IN ('completed', 'failed')`,
      ),
    ...wsPolicies(),
  ],
);
