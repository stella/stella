import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import {
  queryAuditLogPage,
  readAuditLogsQuerySchema,
  validateAuditLogFilter,
} from "./query";

const config = {
  description:
    "Read the organization's audit trail (compliance view). Returns audit " +
    "entries newest first, each with its action, resource type and id, actor " +
    "user id, matter, timestamp, and change detail. Filter by matterId, " +
    "action, resourceType (with optional resourceId), userId, and a " +
    "created-at range (from/to, ISO date-time). Paginate with limit and " +
    "cursor. Requires organization audit-log access.",
  permissions: { auditLog: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "tool", name: "list_audit_log" },
  // Reads the audit trail but records an ACCESS audit row on every call
  // (query.ts recordAuditEvent), so it mutates and must require write consent.
  access: "read",
  query: readAuditLogsQuerySchema,
} satisfies HandlerConfig;

const readAuditLogs = createSafeRootHandler(
  config,
  async function* ({
    safeDb,
    session,
    user,
    featureAccessSnapshot,
    recordAuditEvent,
    query,
  }) {
    const invalid = validateAuditLogFilter(query);
    if (invalid !== null) {
      return Result.err(new HandlerError({ status: 400, message: invalid }));
    }

    return yield* queryAuditLogPage({
      safeDb,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      featureAccessSnapshot,
      recordAuditEvent,
      query,
    });
  },
);

export default readAuditLogs;
