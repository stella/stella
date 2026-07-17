import {
  jsonb,
  p,
  pUuid,
  safeUuid,
  safeWorkspaceId,
  user,
  wsPolicies,
} from "./common";
import type { AnyPgColumn, SafeId, ViewLayout } from "./common";
import { workspaces } from "./contacts";
import { entities } from "./entities";
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
    error: p.text("error"),
    resultEntityId: safeUuid<"entity">("result_entity_id").references(
      (): AnyPgColumn => entities.id,
      { onDelete: "set null" },
    ),
    resultS3Key: p.varchar("result_s3_key", { length: 512 }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
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
    ...wsPolicies(),
  ],
);
