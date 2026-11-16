import { Result } from "better-result";
import { and, desc } from "drizzle-orm";

import { auditLogs } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  ORGANIZATION_AUDIT_LOG_RESOURCE_ID,
} from "@/api/lib/audit-log";
import {
  AUDIT_LOG_EXPORT_CSV_HEADER,
  auditLogExportColumns,
  auditLogExportCsvLine,
  readAuditLogExportActors,
} from "@/api/lib/audit-log-export";
import { readBounded } from "@/api/lib/db/read-bounded";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

import {
  readAuditLogsQuerySchema,
  toAuditLogConditions,
  validateAuditLogFilter,
} from "./query";

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.standard,
  contentDelivery: { type: "audited" },
  permissions: { auditLog: ["read"] },
  mcp: { type: "internal", reason: "ui_navigation_state" },
  query: readAuditLogsQuerySchema,
} satisfies HandlerConfig;

const exportAuditLogs = createSafeRootHandler(
  config,
  async function* ({
    safeDb,
    session,
    user: actor,
    featureAccessSnapshot,
    recordAuditEvent,
    query,
    set,
  }) {
    const invalid = validateAuditLogFilter(query);
    if (invalid !== null) {
      return Result.err(new HandlerError({ status: 400, message: invalid }));
    }

    const conditions = toAuditLogConditions({
      organizationId: session.activeOrganizationId,
      filter: query,
    });

    const readContext = {
      featureAccessSnapshot,
      principal: {
        organizationId: session.activeOrganizationId,
        userId: actor.id,
      },
    };

    const exportResult = yield* Result.await(
      safeDb(async (tx) => {
        const bounded = await readBounded(
          tx
            .select(auditLogExportColumns(readContext))
            .from(auditLogs)
            .where(and(...conditions))
            .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)),
          LIMITS.exportRowLimit,
        );

        if (bounded.type === "overflow") {
          return { type: "tooLarge" as const };
        }

        const { rows } = bounded;
        const actors = await readAuditLogExportActors(
          tx,
          session.activeOrganizationId,
          rows.map((row) => row.userId),
        );

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DOWNLOAD,
          resourceType: AUDIT_RESOURCE_TYPE.AUDIT_LOG,
          resourceId: ORGANIZATION_AUDIT_LOG_RESOURCE_ID,
        });

        return {
          type: "complete" as const,
          rows,
          actors,
        };
      }),
    );

    if (exportResult.type === "tooLarge") {
      return Result.err(
        new HandlerError({
          status: 413,
          message: `The export exceeds ${LIMITS.exportRowLimit} rows. Narrow the filters and try again.`,
        }),
      );
    }

    const csvRows = [AUDIT_LOG_EXPORT_CSV_HEADER];
    for (const row of exportResult.rows) {
      csvRows.push(
        auditLogExportCsvLine({
          row,
          actor: exportResult.actors.get(row.userId),
          ...readContext,
        }),
      );
    }

    set.headers["content-type"] = "text/csv; charset=utf-8";
    set.headers["content-disposition"] =
      'attachment; filename="audit-logs.csv"';

    return Result.ok(csvRows.join("\n"));
  },
);

export default exportAuditLogs;
