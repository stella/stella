import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import {
  ACTIVE_DATA_EXPORT_STATUSES,
  DATA_EXPORT_VERSION_SCOPE_VALUES,
  organizationDataExports,
} from "@/api/db/schema";
import {
  dataExportSummaryColumns,
  toDataExportSummary,
} from "@/api/handlers/data-exports/summary";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { enqueueDataExport } from "@/api/lib/data-export-queue";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

/** Whether this call started the export or found one already running. */
export const DATA_EXPORT_START_OUTCOME = {
  STARTED: "started",
  ALREADY_ACTIVE: "already_active",
} as const;

const config = {
  contract: "patch",
  description:
    "Start a full export of the organization's data: every matter with its " +
    "documents and their complete version history, tasks, time entries, " +
    "invoices and linked contacts, plus organization-wide contacts, clauses " +
    "and templates, as ZIP parts of about 2 GB with a manifest listing every " +
    "file and its SHA-256 checksum. The export runs as low-priority " +
    "background work, so it can take a while for large organizations; poll " +
    "data-exports.get for progress and an estimated time left, then use " +
    "data-exports.download for links. " +
    "One export runs per organization at a time: while one is queued or " +
    "running, this returns that export instead of starting another. Files " +
    "are deleted 7 days after the export starts. Organization owners and " +
    "admins only.",
  permissions: { dataExport: ["create"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  mcp: {
    type: "capability",
    reason: "reporting_export",
    consumesServices: false,
  },
  access: "write",
  body: t.Object({
    versions: t.UnionEnum(DATA_EXPORT_VERSION_SCOPE_VALUES, {
      description:
        "`all` includes every earlier version of every document; `current` only each document's current version.",
    }),
  }),
} satisfies HandlerConfig;

const createDataExport = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, body, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;
    const started = yield* Result.await(
      safeDb(async (tx) => {
        const inserted = await tx
          .insert(organizationDataExports)
          .values({
            organizationId,
            requestedBy: user.id,
            versionScope: body.versions,
          })
          // The partial unique index admits one queued or running export
          // per organisation; a concurrent request lands here.
          .onConflictDoNothing({
            target: organizationDataExports.organizationId,
            where: inArray(organizationDataExports.status, [
              ...ACTIVE_DATA_EXPORT_STATUSES,
            ]),
          })
          .returning(dataExportSummaryColumns);
        const created = inserted.at(0);
        if (created !== undefined) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.DATA_EXPORT,
            resourceId: created.id,
            metadata: { versions: body.versions },
          });
          return {
            outcome: DATA_EXPORT_START_OUTCOME.STARTED,
            row: created,
          };
        }
        const active = await tx
          .select(dataExportSummaryColumns)
          .from(organizationDataExports)
          .where(
            and(
              eq(organizationDataExports.organizationId, organizationId),
              inArray(organizationDataExports.status, [
                ...ACTIVE_DATA_EXPORT_STATUSES,
              ]),
            ),
          )
          .limit(1);
        return {
          outcome: DATA_EXPORT_START_OUTCOME.ALREADY_ACTIVE,
          row: active.at(0) ?? null,
        };
      }),
    );
    if (started.row === null) {
      // The active export finished between the insert and the read.
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Another export just finished; start a new one.",
        }),
      );
    }
    if (started.outcome === DATA_EXPORT_START_OUTCOME.STARTED) {
      const exportId = started.row.id;
      // A failed handoff leaves the row queued; the maintenance sweep hands
      // it to the queue again, so the request still succeeds.
      await enqueueDataExport({
        exportId,
        organizationId,
        userId: user.id,
        attempts: 0,
      }).catch((error: unknown) => {
        captureError(error, { exportId, operation: "data_export.enqueue" });
      });
    }
    return Result.ok({
      outcome: started.outcome,
      export: toDataExportSummary(started.row),
    });
  },
);

export default createDataExport;
