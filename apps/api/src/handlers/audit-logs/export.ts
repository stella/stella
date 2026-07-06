import { Result } from "better-result";
import { and, desc, eq, inArray } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import { auditLogs } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { escapeCSV } from "@/api/lib/csv";
import { LIMITS } from "@/api/lib/limits";

import { readAuditLogsQuerySchema, toAuditLogConditions } from "./read";

const config = {
  permissions: { auditLog: ["read"] },
  mcp: { type: "pending" },
  query: readAuditLogsQuerySchema,
  audit: {
    action: AUDIT_ACTION.DOWNLOAD,
    resourceType: AUDIT_RESOURCE_TYPE.AUDIT_LOG,
    getResourceId: () => "organization-logs",
  },
} satisfies HandlerConfig;

const exportAuditLogs = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, query, set }) {
    const conditions = [
      eq(auditLogs.organizationId, session.activeOrganizationId),
      ...toAuditLogConditions(query),
    ];

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select()
          .from(auditLogs)
          .where(and(...conditions))
          .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
          .limit(LIMITS.exportRowLimit),
      ),
    );

    // Batch-fetch user names/emails
    const userIds = [...new Set(rows.map((row) => row.userId).filter(Boolean))];
    const userDetails =
      userIds.length > 0
        ? yield* Result.await(
            safeDb((tx) =>
              tx
                .select({ id: user.id, name: user.name, email: user.email })
                .from(user)
                .innerJoin(member, eq(member.userId, user.id))
                .where(
                  and(
                    eq(member.organizationId, session.activeOrganizationId),
                    inArray(user.id, userIds),
                  ),
                ),
            ),
          )
        : [];
    const userMap = new Map(
      userDetails.map((u) => [u.id, { name: u.name, email: u.email }]),
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

    for (const row of rows) {
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
