import { Result } from "better-result";
import { and, desc, eq, inArray } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import { auditLogs } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  ORGANIZATION_AUDIT_LOG_RESOURCE_ID,
} from "@/api/lib/audit-log";
import { escapeCSV } from "@/api/lib/csv";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

import {
  readAuditLogsQuerySchema,
  toAuditLogConditions,
  validateAuditLogFilter,
} from "./query";

const config = {
  permissions: { auditLog: ["read"] },
  mcp: { type: "internal", reason: "ui_navigation_state" },
  query: readAuditLogsQuerySchema,
} satisfies HandlerConfig;

const exportAuditLogs = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, recordAuditEvent, query, set }) {
    const invalid = validateAuditLogFilter(query);
    if (invalid !== null) {
      return Result.err(new HandlerError({ status: 400, message: invalid }));
    }

    const conditions = [
      eq(auditLogs.organizationId, session.activeOrganizationId),
      ...toAuditLogConditions(query),
    ];

    const exportResult = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .select({
            createdAt: auditLogs.createdAt,
            userId: auditLogs.userId,
            action: auditLogs.action,
            resourceType: auditLogs.resourceType,
            resourceId: auditLogs.resourceId,
            changes: auditLogs.changes,
          })
          .from(auditLogs)
          .where(and(...conditions))
          .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
          .limit(LIMITS.exportRowLimit + 1);

        if (rows.length > LIMITS.exportRowLimit) {
          return { type: "tooLarge" as const };
        }

        const userIds = [...new Set(rows.map((row) => row.userId))];
        const userDetails =
          userIds.length > 0
            ? await tx
                .select({ id: user.id, name: user.name, email: user.email })
                .from(user)
                .innerJoin(member, eq(member.userId, user.id))
                .where(
                  and(
                    eq(member.organizationId, session.activeOrganizationId),
                    inArray(user.id, userIds),
                  ),
                )
            : [];

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DOWNLOAD,
          resourceType: AUDIT_RESOURCE_TYPE.AUDIT_LOG,
          resourceId: ORGANIZATION_AUDIT_LOG_RESOURCE_ID,
        });

        return {
          type: "complete" as const,
          rows,
          userDetails,
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

    const userMap = new Map(
      exportResult.userDetails.map((actor) => [
        actor.id,
        { name: actor.name, email: actor.email },
      ]),
    );

    const headers = [
      "Time",
      "User Name",
      "User Email",
      "Action",
      "Resource Type",
      "Resource ID",
      "Changes",
    ];

    const csvRows = [headers.join(",")];

    for (const row of exportResult.rows) {
      const u = row.userId ? userMap.get(row.userId) : undefined;
      const userName = u?.name ?? "";
      const userEmail = u?.email ?? "";
      csvRows.push(
        [
          escapeCSV(new Date(row.createdAt).toISOString()),
          escapeCSV(userName),
          escapeCSV(userEmail),
          escapeCSV(row.action),
          escapeCSV(row.resourceType),
          escapeCSV(row.resourceId),
          escapeCSV(row.changes ? JSON.stringify(row.changes) : ""),
        ].join(","),
      );
    }

    set.headers["content-type"] = "text/csv; charset=utf-8";
    set.headers["content-disposition"] =
      'attachment; filename="audit-logs.csv"';

    return Result.ok(csvRows.join("\n"));
  },
);

export default exportAuditLogs;
